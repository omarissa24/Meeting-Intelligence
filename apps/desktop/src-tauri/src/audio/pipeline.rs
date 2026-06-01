//! Worker-thread orchestrator: assembles every DSP stage on a single
//! dedicated thread fed by the sources.
//!
//! The thread owns:
//!   - One `SourceResampler` per active mic source (lazy-initialised on
//!     first mic frame so we adopt cpal's actual rate).
//!   - One `Mixer` summing system + mic at 16 kHz mono.
//!   - One `VadGate` deciding which 320-sample chunks count as voice.
//!   - One `ChunkEncoder` aggregating 50× voice chunks into 1 s WS payloads.
//!
//! The thread is NOT on the Tokio runtime — DSP is synchronous and the
//! source callbacks already live on dedicated audio threads. We use
//! `std::sync::mpsc` for the input and output channels; the controller
//! converts `EncodedChunk`s into Tauri events on the Tokio side.
//!
//! Lifecycle:
//!   `PipelineHandle::spawn(...)` returns the input sink + output stream.
//!   Sources push `AudioFrame`s to the sink. To stop, drop the sink (the
//!   controller does this when sources have stopped) or call `.stop()` —
//!   the worker drains pending audio, flushes the encoder, then exits.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::audio::encoder::{ChunkEncoder, EncodedChunk, EncoderStats};
use crate::audio::mixer::{Mixer, MixerStats};
use crate::audio::resampler::{SourceResampler, FIXED_OUTPUT_FRAMES, TARGET_RATE};
use crate::audio::traits::{AudioFrame, SourceKind};
use crate::audio::vad::{VadGate, Verdict};

/// Bound on the input-side channel — ~200 callbacks of slack. Enough
/// that brief jitter in the worker doesn't drop frames; small enough
/// that a stalled worker shows up as `dropped` counters quickly.
const INPUT_QUEUE_CAP: usize = 200;
/// Output channel slack. The Tokio bridge should drain this faster than
/// real-time; ~20 chunks = 20 s of slack is plenty.
const OUTPUT_QUEUE_CAP: usize = 32;

/// Aggregated stats reported on stop. Subset gets surfaced via
/// `audio://stats` while the session is live.
#[derive(Debug, Default, Clone)]
pub struct PipelineStats {
    pub mixer: MixerStats,
    pub encoder: EncoderStats,
    pub vad_voice_frames: u64,
    pub vad_silence_frames: u64,
    pub mic_frames_in: u64,
    pub system_frames_in: u64,
    pub mic_resampler_errors: u64,
    pub output_dropped: u64,
}

impl PipelineStats {
    pub fn vad_drop_ratio(&self) -> f32 {
        let total = self.vad_voice_frames + self.vad_silence_frames;
        if total == 0 {
            0.0
        } else {
            self.vad_silence_frames as f32 / total as f32
        }
    }
}

/// Live handle returned to the controller. Drop the `audio_sink` and
/// the worker exits naturally; alternatively call `stop()` to wait
/// for the join + grab final stats.
pub struct PipelineHandle {
    audio_sink: SyncSender<AudioFrame>,
    chunk_rx: Receiver<EncodedChunk>,
    join: Option<JoinHandle<PipelineStats>>,
    /// Used to signal "stop now, even if input still has data" from
    /// the controller. Worker also stops on input-channel disconnect,
    /// so this is just for the explicit-stop path.
    stop_tx: Sender<()>,
    /// Live counter of output-channel-full drops. Shared with the
    /// worker; the emitter thread polls this so a sustained drop
    /// can be surfaced to the UI as `audio://error AUDIO_DROP` while
    /// the session is still running, instead of only being visible
    /// post-mortem in the stop reply.
    output_dropped_counter: Arc<AtomicU64>,
}

impl PipelineHandle {
    /// Sender used by sources to push frames in.
    pub fn audio_sink(&self) -> SyncSender<AudioFrame> {
        self.audio_sink.clone()
    }

    /// Receiver consumed by the Tauri event emitter.
    pub fn chunks(&self) -> &Receiver<EncodedChunk> {
        &self.chunk_rx
    }

    /// Take the chunk receiver so it can be moved into the event task.
    /// After this, the handle's other accessors still work but
    /// `chunks()` will panic if called again. Used by the controller's
    /// `start_recording` flow.
    pub fn take_chunks(&mut self) -> Receiver<EncodedChunk> {
        std::mem::replace(&mut self.chunk_rx, sync_channel(0).1)
    }

    /// Live (monotonically-non-decreasing) count of output-channel-full
    /// drops. Cloned and handed to the emitter thread so it can detect
    /// drops and surface an `audio://error` event mid-session.
    pub fn output_dropped_counter(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.output_dropped_counter)
    }

    /// Signal stop and wait for the worker. Returns the final stats.
    pub fn stop(mut self) -> PipelineStats {
        let _ = self.stop_tx.send(());
        // Drop the audio sink so the worker also sees the input
        // channel disconnect — whichever signal arrives first wins.
        drop(self.audio_sink);
        let stats = self
            .join
            .take()
            .expect("PipelineHandle::stop called twice")
            .join()
            .unwrap_or_default();
        stats
    }
}

/// Spawn the worker thread and return a handle.
pub fn spawn() -> PipelineHandle {
    let (audio_sink, audio_rx) = sync_channel::<AudioFrame>(INPUT_QUEUE_CAP);
    let (chunk_tx, chunk_rx) = sync_channel::<EncodedChunk>(OUTPUT_QUEUE_CAP);
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();

    let output_dropped_counter = Arc::new(AtomicU64::new(0));
    let worker_dropped = Arc::clone(&output_dropped_counter);

    let join = std::thread::Builder::new()
        .name("audio-pipeline".into())
        .spawn(move || run_worker(audio_rx, chunk_tx, stop_rx, worker_dropped))
        .expect("failed to spawn audio-pipeline thread");

    PipelineHandle {
        audio_sink,
        chunk_rx,
        join: Some(join),
        stop_tx,
        output_dropped_counter,
    }
}

fn run_worker(
    audio_rx: Receiver<AudioFrame>,
    chunk_tx: SyncSender<EncodedChunk>,
    stop_rx: Receiver<()>,
    output_dropped_counter: Arc<AtomicU64>,
) -> PipelineStats {
    let mut mixer = Mixer::new();
    let mut vad = VadGate::quality();
    let mut encoder = ChunkEncoder::new();
    // Lazy-init: we don't know cpal's rate until the first mic frame.
    let mut mic_resampler: Option<SourceResampler> = None;

    let mut stats = PipelineStats::default();
    let mut mix_scratch = vec![0.0f32; FIXED_OUTPUT_FRAMES];
    let mut i16_scratch = vec![0i16; FIXED_OUTPUT_FRAMES];

    // Periodic budget for stop-signal polling so we don't block on
    // recv forever when input is idle.
    let recv_timeout = Duration::from_millis(50);

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        match audio_rx.recv_timeout(recv_timeout) {
            Ok(frame) => process_frame(
                frame,
                &mut mic_resampler,
                &mut mixer,
                &mut stats,
            ),
            Err(RecvTimeoutError::Timeout) => {
                // Timer-driven flush: even with no new audio we still
                // want to drain whatever the mixer has buffered (e.g.
                // if both sources stop simultaneously).
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }

        drain_mixer(
            &mut mixer,
            &mut vad,
            &mut encoder,
            &chunk_tx,
            &mut stats,
            &mut mix_scratch,
            &mut i16_scratch,
            &output_dropped_counter,
        );
    }

    // Stop path: drain any remaining input, then flush the encoder.
    let drain_deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < drain_deadline {
        match audio_rx.try_recv() {
            Ok(frame) => process_frame(frame, &mut mic_resampler, &mut mixer, &mut stats),
            Err(_) => break,
        }
    }
    drain_mixer(
        &mut mixer,
        &mut vad,
        &mut encoder,
        &chunk_tx,
        &mut stats,
        &mut mix_scratch,
        &mut i16_scratch,
        &output_dropped_counter,
    );
    if let Some(chunk) = encoder.flush() {
        if chunk_tx.send(chunk).is_err() {
            stats.output_dropped += 1;
            output_dropped_counter.fetch_add(1, Ordering::Relaxed);
        }
    }

    finalize_stats(&mut stats, &mixer, &encoder, &vad);
    stats
}

fn process_frame(
    frame: AudioFrame,
    mic_resampler: &mut Option<SourceResampler>,
    mixer: &mut Mixer,
    stats: &mut PipelineStats,
) {
    match frame.kind {
        SourceKind::System => {
            stats.system_frames_in += 1;
            // SCKit is configured for 16 kHz mono, so the samples land
            // straight in the mixer's system ring.
            mixer.push_system(&frame.samples);
        }
        SourceKind::Mic => {
            stats.mic_frames_in += 1;
            // Downmix interleaved channels → mono before resampling.
            let mono = downmix_to_mono(&frame.samples, frame.format.channels as usize);

            // If the mic is already at the target rate, skip the
            // resampler entirely. Otherwise lazy-init / replace if the
            // rate changes mid-session (rare, but cpal can do it on
            // device hot-swap).
            if frame.format.sample_rate == TARGET_RATE {
                mixer.push_mic(&mono);
                return;
            }

            let needs_init = match mic_resampler.as_ref() {
                None => true,
                Some(r) => r.input_rate() != frame.format.sample_rate,
            };
            if needs_init {
                match SourceResampler::new(frame.format.sample_rate) {
                    Ok(r) => *mic_resampler = Some(r),
                    Err(e) => {
                        stats.mic_resampler_errors += 1;
                        eprintln!("audio/pipeline: mic resampler init failed: {e}");
                        return;
                    }
                }
            }
            let resampler = mic_resampler.as_mut().expect("just set above");
            if let Err(e) = resampler.push_and_drain(&mono, |chunk| mixer.push_mic(chunk)) {
                stats.mic_resampler_errors += 1;
                eprintln!("audio/pipeline: mic resampler error: {e}");
            }
        }
    }
}

fn drain_mixer(
    mixer: &mut Mixer,
    vad: &mut VadGate,
    encoder: &mut ChunkEncoder,
    chunk_tx: &SyncSender<EncodedChunk>,
    stats: &mut PipelineStats,
    f32_scratch: &mut [f32],
    i16_scratch: &mut [i16],
    output_dropped_counter: &Arc<AtomicU64>,
) {
    while mixer.try_emit_chunk(f32_scratch) {
        for (i, &s) in f32_scratch.iter().enumerate() {
            i16_scratch[i] = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        }
        match vad.classify(i16_scratch) {
            Ok(Verdict::Voice) => {
                if let Some(chunk) = encoder.push_frame(f32_scratch) {
                    if chunk_tx.send(chunk).is_err() {
                        stats.output_dropped += 1;
                        output_dropped_counter.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            Ok(Verdict::Silence) => {
                // Silence frames are intentionally dropped — that's
                // the whole point of the VAD gate (US-05 / FR-1.04).
            }
            Err(e) => {
                eprintln!("audio/pipeline: VAD error: {e}");
            }
        }
    }
}

fn finalize_stats(
    stats: &mut PipelineStats,
    mixer: &Mixer,
    encoder: &ChunkEncoder,
    vad: &VadGate,
) {
    stats.mixer = mixer.stats().clone();
    stats.encoder = encoder.stats().clone();
    stats.vad_voice_frames = vad.voice_frames();
    stats.vad_silence_frames = vad.silence_frames();
}

/// Average interleaved channels into a mono buffer. macOS mic devices
/// commonly expose mono natively; stereo USB interfaces are the
/// notable exception.
fn downmix_to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    let frames = samples.len() / channels;
    let mut out = Vec::with_capacity(frames);
    let inv = 1.0 / channels as f32;
    for frame in samples.chunks_exact(channels) {
        out.push(frame.iter().sum::<f32>() * inv);
    }
    out
}
