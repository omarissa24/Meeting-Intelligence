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
//! Compiled on macOS and Windows. The mic source is shared (cpal handles
//! both platforms); only the system-audio source differs:
//!   * macOS → `audio::macos::system::SCKitSystemSource` (ScreenCaptureKit)
//!   * Windows → `audio::windows::system::WasapiSystemSource` (WASAPI loopback)

#![cfg(any(target_os = "macos", target_os = "windows"))]
// Audio-error event surface, session-id accessor, and the
// AlreadyRunning variant are intentionally public for the next
// slice (UI toast wiring + race-detection), even though they
// aren't called yet from lib.rs.
#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{get_current_pid, Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Runtime};

use crate::audio::encoder::EncodedChunk;
use crate::audio::cpal_mic::CpalMicSource;
use crate::audio::pipeline::{self, MicLevelStore, PipelineHandle, PipelineStats};
use crate::audio::traits::{MicSource, SourceCounters, SourceError, SystemSource};

#[cfg(target_os = "macos")]
use crate::audio::macos::system::SCKitSystemSource;
#[cfg(target_os = "windows")]
use crate::audio::windows::system::WasapiSystemSource;

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
/// Per-second process telemetry: CPU% + RSS for the desktop binary
/// itself. Lets us validate US-07's ≤8% CPU / ≤200 MB RAM target
/// observationally during a recording instead of guessing. Subscribers
/// listen via `audio-bridge.ts::subscribePerfStats`.
pub const EVENT_PERF_STATS: &str = "perf://stats";
/// ~10 Hz mic-level meter event for the live recording UI (US-25a).
/// Frontend subscribes via `audio-bridge.ts::subscribeMicLevel`. Two
/// dBFS values per tick: raw (post-downmix, pre-gain) and resampled
/// (post-gain, what STT consumes).
pub const EVENT_AUDIO_LEVEL: &str = "audio://level";

/// Cadence for the perf-monitor thread's sample → emit cycle. 1 s
/// matches the `LevelMeter` cadence in `pipeline.rs`, fine-grained
/// enough to catch spikes without flooding the IPC bus.
const PERF_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
/// Cadence for the level-meter emitter thread. 100 ms (~10 Hz) is the
/// US-25a target — fast enough to feel real-time, slow enough that the
/// IPC bus and React rendering layer aren't taxed. The store's
/// swap-on-read semantics mean a missed tick still picks up its peak
/// on the next read, so jitter doesn't evaporate state.
const LEVEL_SAMPLE_INTERVAL: Duration = Duration::from_millis(100);

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

/// Per-tick payload for `perf://stats`. Numbers are scaled the way the
/// UI is going to want to display them — `cpu_percent` is on a 0..=100
/// scale (sysinfo reports per-core utilisation that can exceed 100 on
/// multithreaded work; the perf-monitor divides by core count so the
/// US-07 ≤8% target is directly comparable). `rss_mb` is the resident
/// set in megabytes.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PerfStatsPayload {
    pub session_id: String,
    pub cpu_percent: f32,
    pub rss_mb: f32,
    pub uptime_ms: u64,
}

/// Per-tick payload for `audio://level` (US-25a). Both values are
/// dBFS with a -120.0 floor for silence (matches `pipeline::dbfs`).
/// Negative numbers — the UI converts to a 0..=1 width via
/// `(dbfs + 60) / 60` clamped.
///
/// `mic_raw_dbfs` is the device-side peak before the static gain
/// factor (`MIC_GAIN_DB`); `mic_resampled_dbfs` is the post-gain,
/// post-resample peak (what the encoder/STT consumes). Operators read
/// the gap between the two to decide whether the gain compensation is
/// pulling speech into Deepgram's sweet spot or just clipping it.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MicLevelPayload {
    pub session_id: String,
    pub mic_raw_dbfs: f32,
    pub mic_resampled_dbfs: f32,
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
    /// `None` when the user has system-audio capture toggled off in
    /// settings (US-25). When `None`, the platform `SystemSource` is
    /// never constructed — so `SCShareableContent::get()` is never
    /// invoked on macOS and WASAPI loopback is never opened on Windows.
    system: Option<Box<dyn SystemSource>>,
    pipeline: Option<PipelineHandle>,
    emitter: Option<JoinHandle<u64>>,
    /// Per-second process telemetry thread. Lives the full session
    /// lifetime; signal `perf_stop_tx` then `.join()` to tear it down.
    perf_join: Option<JoinHandle<()>>,
    perf_stop_tx: Sender<()>,
    /// ~10 Hz mic-level emitter thread (US-25a). Reads peaks from the
    /// pipeline's `MicLevelStore` and emits `audio://level`. Same
    /// lifecycle as the perf thread: signal `level_stop_tx` then
    /// `.join()`.
    level_join: Option<JoinHandle<()>>,
    level_stop_tx: Sender<()>,
    /// True when `start` requested a non-default mic device by label
    /// but the device wasn't found and we fell back to the system
    /// default. Read by the orchestrator after `start` to decide
    /// whether to emit a `MIC_DEVICE_FALLBACK` toast.
    pub mic_fell_back_to_default: bool,
}

/// Inputs to `Session::start` that come from the user's settings, not
/// from the audio pipeline itself. Defaults match a fresh install.
#[derive(Debug, Clone, Default)]
pub struct RecordingConfig {
    /// `None` ⇒ system default mic, re-resolved each start. `Some(label)`
    /// matches against `cpal::Device::name()`.
    pub mic_device_label: Option<String>,
    /// When `false`, no system audio source is constructed (no
    /// permission prompt, no WASAPI loopback, no SCKit query).
    pub enable_system_audio: bool,
    /// Optional BCP-47 short code or "auto". Logged here for diagnosis;
    /// the actual STT routing happens in the frontend WS client which
    /// owns ClientHello.
    pub language: Option<String>,
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
        config: RecordingConfig,
    ) -> Result<Self, SessionError> {
        eprintln!(
            "session: start session_id={session_id} mic_device={:?} system_audio={} language={:?}",
            config.mic_device_label,
            config.enable_system_audio,
            config.language,
        );

        let mut mic =
            CpalMicSource::new().with_device_label(config.mic_device_label.clone());

        let mut pipeline = pipeline::spawn();
        let audio_sink = pipeline.audio_sink();

        // System audio is gated on the user's setting. When disabled,
        // we never construct the platform SystemSource, so neither
        // ScreenCaptureKit (macOS) nor WASAPI loopback (Windows) is
        // touched and macOS won't fire the screen-recording permission
        // prompt.
        let mut system_opt: Option<Box<dyn SystemSource>> = if config.enable_system_audio {
            #[cfg(target_os = "macos")]
            let mut system = SCKitSystemSource::new();
            #[cfg(target_os = "windows")]
            let mut system = WasapiSystemSource::new();

            if let Err(e) = system.start(audio_sink.clone()) {
                let _ = pipeline.stop();
                return Err(SessionError::Source(e));
            }
            Some(Box::new(system) as Box<dyn SystemSource>)
        } else {
            None
        };

        if let Err(e) = mic.start(audio_sink) {
            // Best-effort cleanup: stop system (if started), then pipeline.
            if let Some(system) = system_opt.as_mut() {
                let _ = system.stop();
            }
            let _ = pipeline.stop();
            return Err(SessionError::Source(e));
        }
        let mic_fell_back_to_default = mic.take_fell_back_to_default();

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

        // Independent telemetry thread — emits `perf://stats` once per
        // second so a developer or the future stability harness can
        // confirm the US-07 CPU/RAM targets without instrumentation
        // changes mid-recording.
        let (perf_stop_tx, perf_stop_rx) = mpsc::channel::<()>();
        let perf_join = spawn_perf_monitor_thread(
            app.clone(),
            session_id.clone(),
            perf_stop_rx,
        );

        // Live mic-level meter (US-25a). Grab the shared peak store
        // before `pipeline` is moved into the struct below, then spawn a
        // ~10 Hz thread that drains it into `audio://level` events.
        let mic_level_store = pipeline.mic_level_store();
        let (level_stop_tx, level_stop_rx) = mpsc::channel::<()>();
        let level_join = spawn_level_emitter_thread(
            app.clone(),
            session_id.clone(),
            mic_level_store,
            level_stop_rx,
        );

        Ok(Self {
            session_id,
            mic: Box::new(mic),
            system: system_opt,
            pipeline: Some(pipeline),
            emitter: Some(emitter),
            perf_join: Some(perf_join),
            perf_stop_tx,
            level_join: Some(level_join),
            level_stop_tx,
            mic_fell_back_to_default,
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
        if let Some(system) = self.system.as_mut() {
            if let Err(e) = system.stop() {
                eprintln!("session: system.stop failed: {e}");
            }
        }

        // Capture source-side counters before we drop them.
        let mic_counters = self.mic.counters();
        let system_counters = self
            .system
            .as_ref()
            .map(|s| s.counters())
            .unwrap_or_default();

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

        // 4. Perf monitor — independent of the audio path; stop after
        //    the emitter so the last few stats events still go out.
        //    Signal then join; the thread wakes from its sleep tick at
        //    most every 1 s so this can take that long in the worst
        //    case (acceptable, runs in the stop_recording IPC reply).
        let _ = self.perf_stop_tx.send(());
        if let Some(handle) = self.perf_join.take() {
            let _ = handle.join();
        }

        // 5. Level emitter — same teardown as the perf monitor. Worst
        //    case it wakes from its 100 ms tick before exiting.
        let _ = self.level_stop_tx.send(());
        if let Some(handle) = self.level_join.take() {
            let _ = handle.join();
        }

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
        if let Some(system) = self.system.as_mut() {
            let _ = system.stop();
        }
        if let Some(handle) = self.pipeline.take() {
            let _ = handle.stop();
        }
        if let Some(handle) = self.emitter.take() {
            let _ = handle.join();
        }
        let _ = self.perf_stop_tx.send(());
        if let Some(handle) = self.perf_join.take() {
            let _ = handle.join();
        }
        let _ = self.level_stop_tx.send(());
        if let Some(handle) = self.level_join.take() {
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

/// Per-session telemetry thread. Refreshes the current process's CPU%
/// and resident memory once per `PERF_SAMPLE_INTERVAL`, emits a
/// `perf://stats` Tauri event with the values, and `eprintln!`s the
/// same values to stderr so they show up in `pnpm tauri:dev`.
///
/// The first sample is always 0% CPU — sysinfo's CPU usage is a delta
/// between two refreshes, so the first refresh has nothing to compare
/// against. Subsequent ticks land at real values.
fn spawn_perf_monitor_thread<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    stop_rx: Receiver<()>,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("perf-monitor".into())
        .spawn(move || {
            // Resolving the PID can fail in exotic sandboxes; if it does,
            // log once and exit cleanly — no point keeping a thread
            // around that can't sample anything.
            let pid: Pid = match get_current_pid() {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("perf-monitor: get_current_pid failed: {e}; thread exiting");
                    return;
                }
            };
            let cpu_count = std::thread::available_parallelism()
                .map(|n| n.get() as f32)
                .unwrap_or(1.0);

            let mut sys = System::new();
            let started_at = Instant::now();
            let pids = [pid];

            // Loop body: wait up to PERF_SAMPLE_INTERVAL on the stop
            // signal; if it doesn't arrive, sample and emit.
            loop {
                match stop_rx.recv_timeout(PERF_SAMPLE_INTERVAL) {
                    Ok(()) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }

                sys.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&pids),
                    false,
                    ProcessRefreshKind::new().with_cpu().with_memory(),
                );

                let Some(proc) = sys.process(pid) else {
                    eprintln!("perf-monitor: process {pid:?} disappeared; exiting");
                    break;
                };

                // sysinfo reports CPU usage summed across cores
                // (e.g. 200% on a fully loaded 2-core process). Divide
                // by core count so the value is directly comparable to
                // the US-07 ≤8% target on a 4-core machine.
                let cpu_percent = proc.cpu_usage() / cpu_count;
                let rss_mb = proc.memory() as f32 / (1024.0 * 1024.0);
                let uptime_ms = started_at.elapsed().as_millis() as u64;

                eprintln!(
                    "perf://stats session_id={session_id} cpu_percent={cpu_percent:.2} rss_mb={rss_mb:.1} uptime_ms={uptime_ms}",
                );

                let payload = PerfStatsPayload {
                    session_id: session_id.clone(),
                    cpu_percent,
                    rss_mb,
                    uptime_ms,
                };
                if let Err(e) = app.emit(EVENT_PERF_STATS, payload) {
                    eprintln!("perf-monitor: emit failed: {e}");
                }
            }
        })
        .expect("failed to spawn perf-monitor thread")
}

/// Live mic-level meter thread (US-25a). Once per `LEVEL_SAMPLE_INTERVAL`
/// it drains the pipeline's `MicLevelStore` (swap-on-read, so a missed
/// tick still picks up its window's peak) and emits an `audio://level`
/// event carrying both the raw (pre-gain, device-side) and resampled
/// (post-gain, what STT consumes) peaks in dBFS.
///
/// Same teardown contract as the perf-monitor thread: it blocks on
/// `stop_rx.recv_timeout`, so `Session::stop` signals then joins it.
fn spawn_level_emitter_thread<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    mic_level_store: Arc<MicLevelStore>,
    stop_rx: Receiver<()>,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("level-emitter".into())
        .spawn(move || loop {
            match stop_rx.recv_timeout(LEVEL_SAMPLE_INTERVAL) {
                Ok(()) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }

            let (mic_raw_dbfs, mic_resampled_dbfs) = mic_level_store.swap_dbfs();
            let payload = MicLevelPayload {
                session_id: session_id.clone(),
                mic_raw_dbfs,
                mic_resampled_dbfs,
            };
            if let Err(e) = app.emit(EVENT_AUDIO_LEVEL, payload) {
                eprintln!("level-emitter: emit failed: {e}");
            }
        })
        .expect("failed to spawn level-emitter thread")
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
