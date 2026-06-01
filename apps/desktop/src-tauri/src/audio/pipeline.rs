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
use crate::audio::vad::VadGate;

/// Bound on the input-side channel — ~200 callbacks of slack. Enough
/// that brief jitter in the worker doesn't drop frames; small enough
/// that a stalled worker shows up as `dropped` counters quickly.
const INPUT_QUEUE_CAP: usize = 200;
/// Output channel slack. The Tokio bridge should drain this faster than
/// real-time; ~20 chunks = 20 s of slack is plenty.
const OUTPUT_QUEUE_CAP: usize = 32;

/// macOS defaults the input-volume slider to ~50%, which lands typical
/// speech around -24 dBFS peak — quiet enough that Deepgram intermittently
/// drops words. +6 dB doubles the amplitude (linear factor ≈ 2.0) and
/// pulls speech into the -18 dBFS sweet spot. Loud-mic users will clip
/// occasionally on peaks; that's the documented Phase-1 trade.
/// Override at session start with `MIC_GAIN_DB`.
const DEFAULT_MIC_GAIN_DB: f32 = 6.0;
const MIC_GAIN_ENV_VAR: &str = "MIC_GAIN_DB";

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

    // Resolve mic gain at spawn time so this session honors the env
    // var as it was when the user clicked Record. Logged immediately so
    // the operator sees the active gain in the dev console.
    let mic_gain_factor =
        parse_mic_gain_factor(std::env::var(MIC_GAIN_ENV_VAR).ok().as_deref());
    let resolved_db = 20.0 * mic_gain_factor.log10();
    eprintln!(
        "audio/pipeline: mic gain = {resolved_db:+.1} dB (linear ~{mic_gain_factor:.3})"
    );

    let join = std::thread::Builder::new()
        .name("audio-pipeline".into())
        .spawn(move || run_worker(audio_rx, chunk_tx, stop_rx, worker_dropped, mic_gain_factor))
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
    mic_gain_factor: f32,
) -> PipelineStats {
    let mut mixer = Mixer::new();
    let mut vad = VadGate::quality();
    let mut encoder = ChunkEncoder::new();
    // Lazy-init: we don't know cpal's rate until the first mic frame.
    let mut mic_resampler: Option<SourceResampler> = None;

    let mut stats = PipelineStats::default();
    let mut mix_scratch = vec![0.0f32; FIXED_OUTPUT_FRAMES];
    let mut i16_scratch = vec![0i16; FIXED_OUTPUT_FRAMES];

    // Diagnostic level meters — accumulate samples for ~1 s then log
    // peak + RMS in dBFS for each stage. Tells us where attenuation
    // is happening if Deepgram reports silence: raw-mic-quiet ⇒ system
    // input or device; raw-mic-loud-but-resampled-quiet ⇒ resampler;
    // both-quiet-but-mixed-quieter ⇒ mixer gain policy.
    let mut mic_raw_meter = LevelMeter::new("mic_raw");
    let mut mic_resampled_meter = LevelMeter::new("mic_resampled");
    let mut system_meter = LevelMeter::new("system");
    let mut mixed_meter = LevelMeter::new("mixed");

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
                &mut mic_raw_meter,
                &mut mic_resampled_meter,
                &mut system_meter,
                mic_gain_factor,
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
            &mut mixed_meter,
        );
    }

    // Stop path: drain any remaining input, then flush the encoder.
    let drain_deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < drain_deadline {
        match audio_rx.try_recv() {
            Ok(frame) => process_frame(
                frame,
                &mut mic_resampler,
                &mut mixer,
                &mut stats,
                &mut mic_raw_meter,
                &mut mic_resampled_meter,
                &mut system_meter,
                mic_gain_factor,
            ),
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
        &mut mixed_meter,
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
    mic_raw_meter: &mut LevelMeter,
    mic_resampled_meter: &mut LevelMeter,
    system_meter: &mut LevelMeter,
    mic_gain_factor: f32,
) {
    match frame.kind {
        SourceKind::System => {
            stats.system_frames_in += 1;
            system_meter.observe(&frame.samples);
            // SCKit is configured for 16 kHz mono, so the samples land
            // straight in the mixer's system ring.
            mixer.push_system(&frame.samples);
        }
        SourceKind::Mic => {
            stats.mic_frames_in += 1;
            // Downmix interleaved channels → mono before resampling.
            let mut mono = downmix_to_mono(&frame.samples, frame.format.channels as usize);
            mic_raw_meter.observe(&mono);
            // Apply the resolved static gain in place. The encoder hard-
            // clamps any overshoot at ±1.0 (`encoder.rs::f32_to_i16`),
            // so accidental clipping degrades to deterministic clipping
            // rather than wraparound.
            if (mic_gain_factor - 1.0).abs() > f32::EPSILON {
                for s in &mut mono {
                    *s *= mic_gain_factor;
                }
            }

            // If the mic is already at the target rate, skip the
            // resampler entirely. Otherwise lazy-init / replace if the
            // rate changes mid-session (rare, but cpal can do it on
            // device hot-swap).
            if frame.format.sample_rate == TARGET_RATE {
                mic_resampled_meter.observe(&mono);
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
            if let Err(e) = resampler.push_and_drain(&mono, |chunk| {
                mic_resampled_meter.observe(chunk);
                mixer.push_mic(chunk);
            }) {
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
    mixed_meter: &mut LevelMeter,
) {
    while mixer.try_emit_chunk(f32_scratch) {
        mixed_meter.observe(f32_scratch);
        for (i, &s) in f32_scratch.iter().enumerate() {
            i16_scratch[i] = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        }
        // Run VAD for its stats only — FR-1.04 wanted silence dropping for
        // bandwidth, but Deepgram's streaming model expects continuous audio
        // with natural pauses (it relies on silence for utterance
        // endpointing). Dropping voice frames into a packed stream made
        // Nova-2 transcribe nothing because words got slammed together with
        // no gaps. Keep the classifier so vad_drop_ratio is still reported,
        // but pass *every* frame through to the encoder. The standalone
        // VAD-gated pipeline can come back when the MP3-archive path
        // (FR-2.06) lands and wants its own bandwidth-optimized encode.
        let _ = vad.classify(i16_scratch);
        if let Some(chunk) = encoder.push_frame(f32_scratch) {
            if chunk_tx.send(chunk).is_err() {
                stats.output_dropped += 1;
                output_dropped_counter.fetch_add(1, Ordering::Relaxed);
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

/// Diagnostic level meter — accumulates samples across calls and logs
/// peak + RMS in dBFS once per second. Strictly for "where is the gain
/// dropping?" investigations; cheap enough to leave behind a feature
/// flag if we keep it long term, but for now just an unconditional
/// stderr log so it's visible in `pnpm tauri:dev` output.
struct LevelMeter {
    label: &'static str,
    last_log: Instant,
    sum_sq: f64,
    peak: f32,
    n: usize,
}

impl LevelMeter {
    fn new(label: &'static str) -> Self {
        Self {
            label,
            last_log: Instant::now(),
            sum_sq: 0.0,
            peak: 0.0,
            n: 0,
        }
    }

    fn observe(&mut self, samples: &[f32]) {
        for &s in samples {
            let a = s.abs();
            if a > self.peak {
                self.peak = a;
            }
            self.sum_sq += (s as f64) * (s as f64);
        }
        self.n += samples.len();
        if self.last_log.elapsed() >= Duration::from_secs(1) {
            let rms = if self.n > 0 {
                ((self.sum_sq / self.n as f64).sqrt()) as f32
            } else {
                0.0
            };
            eprintln!(
                "audio/level {}: peak={:>6.1} dBFS rms={:>6.1} dBFS n={}",
                self.label,
                dbfs(self.peak),
                dbfs(rms),
                self.n,
            );
            self.last_log = Instant::now();
            self.sum_sq = 0.0;
            self.peak = 0.0;
            self.n = 0;
        }
    }
}

fn dbfs(amp: f32) -> f32 {
    if amp <= 1e-9 {
        return -120.0;
    }
    20.0 * amp.log10()
}

/// Convert a dB value to a linear amplitude factor: `10 ** (db / 20)`.
fn db_to_linear(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Parse `MIC_GAIN_DB`-style env values into a linear gain factor.
/// `None`, empty, NaN, or non-numeric input falls back to
/// `DEFAULT_MIC_GAIN_DB`. Negative values (attenuation) are honored.
/// Pure function so the parsing rules stay test-locked.
fn parse_mic_gain_factor(env_value: Option<&str>) -> f32 {
    match env_value.map(str::trim).filter(|s| !s.is_empty()) {
        None => db_to_linear(DEFAULT_MIC_GAIN_DB),
        Some(s) => match s.parse::<f32>() {
            Ok(db) if db.is_finite() => db_to_linear(db),
            Ok(_) | Err(_) => {
                eprintln!(
                    "audio/pipeline: invalid {MIC_GAIN_ENV_VAR}={s:?}, falling back to +{DEFAULT_MIC_GAIN_DB} dB",
                );
                db_to_linear(DEFAULT_MIC_GAIN_DB)
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn default_gain_is_plus_six_db() {
        let g = parse_mic_gain_factor(None);
        assert!(approx_eq(g, 1.9953), "expected ~1.9953, got {g}");
    }

    #[test]
    fn empty_or_whitespace_falls_back_to_default() {
        assert!(approx_eq(parse_mic_gain_factor(Some("")), 1.9953));
        assert!(approx_eq(parse_mic_gain_factor(Some("   ")), 1.9953));
    }

    #[test]
    fn zero_db_is_unity_gain() {
        assert!(approx_eq(parse_mic_gain_factor(Some("0")), 1.0));
    }

    #[test]
    fn twelve_db_is_roughly_four_x() {
        let g = parse_mic_gain_factor(Some("12"));
        assert!(approx_eq(g, 3.981), "expected ~3.981, got {g}");
    }

    #[test]
    fn negative_db_attenuates() {
        // -6 dB ≈ 0.5
        let g = parse_mic_gain_factor(Some("-6"));
        assert!(approx_eq(g, 0.501), "expected ~0.501, got {g}");
    }

    #[test]
    fn non_numeric_falls_back_to_default() {
        assert!(approx_eq(parse_mic_gain_factor(Some("garbage")), 1.9953));
    }

    #[test]
    fn nan_falls_back_to_default() {
        // f32::parse accepts "NaN", but we reject non-finite values.
        assert!(approx_eq(parse_mic_gain_factor(Some("NaN")), 1.9953));
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        let g = parse_mic_gain_factor(Some("  6  "));
        assert!(approx_eq(g, 1.9953), "expected ~1.9953, got {g}");
    }
}
