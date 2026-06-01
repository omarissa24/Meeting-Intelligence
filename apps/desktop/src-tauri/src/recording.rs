//! Recording session glue.
//!
//! `Session` is the live object held in Tauri-managed state while a
//! recording is in progress. It owns the audio sources (mic + system),
//! the pipeline worker thread, and an emitter thread that converts
//! `EncodedChunk`s into `audio://chunk` Tauri events.
//!
//! The Tauri command layer interacts with this via `Session::start` /
//! `Session::stop` only — internals stay private.
//!
//! Lifecycle:
//!     start_recording  →  Session::start(app)         (lib.rs)
//!         ↓ spawn pipeline, sources, emitter thread
//!     audio frames flow: sources → pipeline → emitter → frontend
//!     stop_recording   →  Session::stop()             (lib.rs)
//!         ↓ stop sources (no more input)
//!         ↓ drop pipeline sink → worker drains, exits
//!         ↓ emitter thread sees disconnect, exits
//!         ↓ join everything; return SessionStats
//!
//! Only macOS for this slice. The Windows source impls plug in behind
//! the same trait surface in a later slice; this file gains a
//! `cfg(target_os = "windows")` branch when WASAPI lands.

#![cfg(target_os = "macos")]
// Audio-error event surface, session-id accessor, and the
// AlreadyRunning variant are intentionally public for the next
// slice (UI toast wiring + race-detection), even though they
// aren't called yet from lib.rs.
#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::audio::encoder::EncodedChunk;
use crate::audio::macos::{mic::CpalMicSource, system::SCKitSystemSource};
use crate::audio::pipeline::{self, PipelineHandle, PipelineStats};
use crate::audio::traits::{MicSource, SourceCounters, SourceError, SystemSource};

/// Minimum gap between emitted `audio://error AUDIO_DROP` events. A
/// sustained drop condition still surfaces immediately on the first
/// occurrence; subsequent drops within this window are suppressed so
/// the toast/banner doesn't spam.
const DROP_NOTICE_INTERVAL: Duration = Duration::from_secs(10);

/// Tauri event name for each emitted PCM chunk. Must match the
/// frontend's `listen('audio://chunk')` call.
pub const EVENT_AUDIO_CHUNK: &str = "audio://chunk";
/// Capture-side error event: device disconnected, perms revoked
/// mid-session, etc. Frontend surfaces these via the existing toast.
pub const EVENT_AUDIO_ERROR: &str = "audio://error";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunkPayload {
    pub session_id: String,
    pub seq: u64,
    pub pcm_base64: String,
    pub duration_ms: u32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioErrorPayload {
    pub session_id: String,
    pub code: &'static str,
    pub message: String,
    pub recoverable: bool,
}

/// Stats handed back to the Tauri stop command, surfaced to the UI as
/// part of the `stop_recording` reply (not yet read by the frontend
/// but logged for now). Mirrors `PipelineStats` plus capture-side
/// counters.
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub mic_frames_received: u64,
    pub mic_frames_dropped: u64,
    pub system_frames_received: u64,
    pub system_frames_dropped: u64,
    pub vad_voice_frames: u64,
    pub vad_silence_frames: u64,
    pub vad_drop_ratio: f32,
    pub chunks_emitted: u64,
    pub samples_in: u64,
    pub trailing_samples_flushed: u32,
    pub mixer_chunks_emitted: u64,
    pub system_drift_drops: u64,
    pub mic_drift_drops: u64,
    pub mic_resampler_errors: u64,
    pub output_dropped_at_emitter: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("source error: {0}")]
    Source(#[from] SourceError),
    #[error("session already running")]
    AlreadyRunning,
}

pub struct Session {
    session_id: String,
    mic: Box<dyn MicSource>,
    system: Box<dyn SystemSource>,
    pipeline: Option<PipelineHandle>,
    emitter: Option<JoinHandle<u64>>,
}

impl Session {
    /// Start mic + system capture, spin up the pipeline, and start
    /// emitting `audio://chunk` events for `session_id`. The Tauri
    /// command should call this from the IPC thread; cpal/SCKit
    /// callbacks land on dedicated threads so the brief
    /// `start_capture()` calls here are the only thing the IPC
    /// thread blocks on (typically <100 ms).
    pub fn start<R: Runtime>(
        app: &AppHandle<R>,
        session_id: String,
    ) -> Result<Self, SessionError> {
        let mut mic = CpalMicSource::new();
        let mut system = SCKitSystemSource::new();

        let mut pipeline = pipeline::spawn();
        let audio_sink = pipeline.audio_sink();

        // Start sources second so any failure here doesn't leave the
        // pipeline thread orphaned. If `system.start` fails, the
        // sink-clone is dropped along with `audio_sink` and the
        // pipeline exits cleanly.
        if let Err(e) = system.start(audio_sink.clone()) {
            // Stop pipeline before bubbling the error up.
            let _ = pipeline.stop();
            return Err(SessionError::Source(e));
        }
        if let Err(e) = mic.start(audio_sink) {
            // Best-effort cleanup: stop system, then pipeline.
            let _ = system.stop();
            let _ = pipeline.stop();
            return Err(SessionError::Source(e));
        }

        // Take the chunk receiver out of the handle so we can move it
        // into the emitter thread without losing access to the rest
        // of the handle (audio_sink, stop_tx).
        let chunk_rx = pipeline.take_chunks();
        let output_dropped = pipeline.output_dropped_counter();
        let emitter = spawn_emitter_thread(
            app.clone(),
            session_id.clone(),
            chunk_rx,
            output_dropped,
        );

        Ok(Self {
            session_id,
            mic: Box::new(mic),
            system: Box::new(system),
            pipeline: Some(pipeline),
            emitter: Some(emitter),
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Stop everything in the right order:
    ///   1. Pause sources so no more frames arrive.
    ///   2. Drop the pipeline (drain + flush partial encoder chunk).
    ///   3. Join the emitter thread.
    /// Returns the aggregated stats — caller turns them into the
    /// `stop_recording` reply payload.
    pub fn stop(mut self) -> SessionStats {
        // 1. Sources first. Errors here are logged but never fatal —
        //    the goal is to land in a clean idle state.
        if let Err(e) = self.mic.stop() {
            eprintln!("session: mic.stop failed: {e}");
        }
        if let Err(e) = self.system.stop() {
            eprintln!("session: system.stop failed: {e}");
        }

        // Capture source-side counters before we drop them.
        let mic_counters = self.mic.counters();
        let system_counters = self.system.counters();

        // 2. Pipeline: dropping its sink is implicit when the
        //    PipelineHandle goes out of scope inside .stop(). The
        //    explicit stop signal short-circuits the recv timeout
        //    so we don't wait for the timeout window.
        let pipeline_stats = self
            .pipeline
            .take()
            .map(PipelineHandle::stop)
            .unwrap_or_default();

        // 3. Emitter thread sees the chunk_rx disconnect and exits;
        //    join it so the IPC thread doesn't return before all
        //    final events have been emitted.
        let emitter_dropped = self
            .emitter
            .take()
            .and_then(|h| h.join().ok())
            .unwrap_or(0);

        merge_stats(
            mic_counters,
            system_counters,
            pipeline_stats,
            emitter_dropped,
        )
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // If the controller forgot to call stop(), still try to
        // gracefully tear down so we don't leak threads or device
        // handles. Errors are swallowed because we're already
        // cleaning up.
        let _ = self.mic.stop();
        let _ = self.system.stop();
        if let Some(handle) = self.pipeline.take() {
            let _ = handle.stop();
        }
        if let Some(handle) = self.emitter.take() {
            let _ = handle.join();
        }
    }
}

fn spawn_emitter_thread<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    rx: Receiver<EncodedChunk>,
    pipeline_dropped: Arc<AtomicU64>,
) -> JoinHandle<u64> {
    std::thread::Builder::new()
        .name("audio-emitter".into())
        .spawn(move || {
            let mut emitter_dropped: u64 = 0;
            // Last value of pipeline_dropped we already notified the UI
            // about; lets us notify the very first time the pipeline
            // drops a chunk and re-notify after the rate-limit window.
            let mut last_notified_pipeline_dropped: u64 = 0;
            let mut last_notice_at: Option<Instant> = None;

            for chunk in rx.iter() {
                let payload = AudioChunkPayload {
                    session_id: session_id.clone(),
                    seq: chunk.seq,
                    pcm_base64: chunk.pcm_base64,
                    duration_ms: chunk.duration_ms,
                };
                if let Err(e) = app.emit(EVENT_AUDIO_CHUNK, payload) {
                    emitter_dropped += 1;
                    if emitter_dropped == 1 {
                        eprintln!(
                            "audio-emitter: first failed emit: {e}; session_id={session_id}"
                        );
                    }
                    maybe_emit_drop_notice(
                        &app,
                        &session_id,
                        "transcript event delivery failed",
                        &mut last_notice_at,
                    );
                }

                // Pipeline-side drop check: read the shared counter once
                // per chunk, surface a single notice per
                // DROP_NOTICE_INTERVAL window.
                let cur = pipeline_dropped.load(Ordering::Relaxed);
                if cur > last_notified_pipeline_dropped {
                    last_notified_pipeline_dropped = cur;
                    maybe_emit_drop_notice(
                        &app,
                        &session_id,
                        "audio output buffer full; some audio was dropped",
                        &mut last_notice_at,
                    );
                }
            }
            emitter_dropped
        })
        .expect("failed to spawn audio-emitter thread")
}

fn maybe_emit_drop_notice<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    message: &str,
    last_notice_at: &mut Option<Instant>,
) {
    let now = Instant::now();
    let due = match *last_notice_at {
        None => true,
        Some(t) => now.duration_since(t) >= DROP_NOTICE_INTERVAL,
    };
    if !due {
        return;
    }
    *last_notice_at = Some(now);
    let payload = AudioErrorPayload {
        session_id: session_id.to_string(),
        code: "AUDIO_DROP",
        message: message.to_string(),
        recoverable: true,
    };
    let _ = app.emit(EVENT_AUDIO_ERROR, payload);
}

fn merge_stats(
    mic: SourceCounters,
    system: SourceCounters,
    pipeline: PipelineStats,
    emitter_dropped: u64,
) -> SessionStats {
    let drop_ratio = pipeline.vad_drop_ratio();
    SessionStats {
        mic_frames_received: mic.received,
        mic_frames_dropped: mic.dropped,
        system_frames_received: system.received,
        system_frames_dropped: system.dropped,
        vad_voice_frames: pipeline.vad_voice_frames,
        vad_silence_frames: pipeline.vad_silence_frames,
        vad_drop_ratio: drop_ratio,
        chunks_emitted: pipeline.encoder.chunks_emitted,
        samples_in: pipeline.encoder.samples_in,
        trailing_samples_flushed: pipeline.encoder.trailing_samples_flushed,
        mixer_chunks_emitted: pipeline.mixer.chunks_emitted,
        system_drift_drops: pipeline.mixer.system_drift_drops,
        mic_drift_drops: pipeline.mixer.mic_drift_drops,
        mic_resampler_errors: pipeline.mic_resampler_errors,
        output_dropped_at_emitter: emitter_dropped,
    }
}
