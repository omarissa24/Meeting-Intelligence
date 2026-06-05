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

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use webrtc_vad::VadMode;

use crate::audio::encoder::{ChunkEncoder, EncodedChunk, EncoderStats};
use crate::audio::mixer::{Mixer, MixerStats};
use crate::audio::resampler::{SourceResampler, FIXED_OUTPUT_FRAMES, TARGET_RATE};
use crate::audio::traits::{AudioFrame, SourceKind};
use crate::audio::vad::{parse_vad_mode, VadGate, VAD_MODE_ENV_VAR};

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
    /// Lock-free shared peak store the level emitter thread reads
    /// once per ~100 ms tick to fill `audio://level` events. The
    /// worker is the only writer; cloning this `Arc` and handing it
    /// to the emitter is the entire wiring.
    mic_level_store: Arc<MicLevelStore>,
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

    /// Shared mic-level peak store. Cloned by `Session::start` and
    /// handed to the level emitter thread. Single-writer (worker) /
    /// single-reader (emitter) — see `MicLevelStore`.
    pub fn mic_level_store(&self) -> Arc<MicLevelStore> {
        Arc::clone(&self.mic_level_store)
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

    let mic_level_store = Arc::new(MicLevelStore::new());
    let worker_level_store = Arc::clone(&mic_level_store);

    // Resolve mic gain at spawn time so this session honors the env
    // var as it was when the user clicked Record. Logged immediately so
    // the operator sees the active gain in the dev console.
    let mic_gain_factor =
        parse_mic_gain_factor(std::env::var(MIC_GAIN_ENV_VAR).ok().as_deref());
    let resolved_db = 20.0 * mic_gain_factor.log10();
    eprintln!(
        "audio/pipeline: mic gain = {resolved_db:+.1} dB (linear ~{mic_gain_factor:.3})"
    );

    // Resolve VAD aggressiveness mode the same way — picked once per
    // session at spawn so the value the operator set when they clicked
    // Record is the value the worker uses end-to-end.
    let vad_mode = parse_vad_mode(std::env::var(VAD_MODE_ENV_VAR).ok().as_deref());
    eprintln!("audio/pipeline: vad mode = {}", vad_mode_label(&vad_mode));

    let join = std::thread::Builder::new()
        .name("audio-pipeline".into())
        .spawn(move || {
            run_worker(
                audio_rx,
                chunk_tx,
                stop_rx,
                worker_dropped,
                worker_level_store,
                mic_gain_factor,
                vad_mode,
            )
        })
        .expect("failed to spawn audio-pipeline thread");

    PipelineHandle {
        audio_sink,
        chunk_rx,
        join: Some(join),
        stop_tx,
        output_dropped_counter,
        mic_level_store,
    }
}

fn run_worker(
    audio_rx: Receiver<AudioFrame>,
    chunk_tx: SyncSender<EncodedChunk>,
    stop_rx: Receiver<()>,
    output_dropped_counter: Arc<AtomicU64>,
    mic_level_store: Arc<MicLevelStore>,
    mic_gain_factor: f32,
    vad_mode: VadMode,
) -> PipelineStats {
    let mut mixer = Mixer::new();
    let mut vad = VadGate::new(vad_mode);
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
                &mic_level_store,
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
                &mic_level_store,
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
    mic_level_store: &MicLevelStore,
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
            mic_level_store.observe_raw(&mono);
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
                mic_level_store.observe_resampled(&mono);
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
                mic_level_store.observe_resampled(chunk);
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

/// Lock-free shared peak store for the live mic-level meter (US-25a).
///
/// Single-writer (the pipeline worker) / single-reader (the level
/// emitter thread). Stores f32 peak amplitudes as `u32` bit-patterns in
/// `AtomicU32` because there is no native atomic-max on f32.
///
/// Reset is on `swap_peaks()` — never on a wall clock — so a missed
/// emitter tick (sleep jitter, GC pause) doesn't evaporate the peak
/// for that window: the next swap still returns the largest sample
/// observed since the previous swap.
///
/// `mic_raw` is the peak observed post-downmix but **before** the
/// static gain factor. `mic_resampled` is the peak **after** gain and
/// resampling — i.e. what the encoder/STT actually consumes.
pub struct MicLevelStore {
    mic_raw_peak_bits: AtomicU32,
    mic_resampled_peak_bits: AtomicU32,
}

impl MicLevelStore {
    pub fn new() -> Self {
        Self {
            mic_raw_peak_bits: AtomicU32::new(0),
            mic_resampled_peak_bits: AtomicU32::new(0),
        }
    }

    pub fn observe_raw(&self, samples: &[f32]) {
        Self::observe(&self.mic_raw_peak_bits, samples);
    }

    pub fn observe_resampled(&self, samples: &[f32]) {
        Self::observe(&self.mic_resampled_peak_bits, samples);
    }

    fn observe(slot: &AtomicU32, samples: &[f32]) {
        let mut local_peak: f32 = 0.0;
        for &s in samples {
            let a = s.abs();
            if a > local_peak {
                local_peak = a;
            }
        }
        if local_peak <= 0.0 {
            return;
        }
        // CAS loop because there's no atomic-max-f32. We compare on
        // bit pattern — only valid because we keep `peak >= 0` so the
        // sign bit is never set and bit-order matches numeric order.
        let new_bits = local_peak.to_bits();
        let mut cur = slot.load(Ordering::Relaxed);
        loop {
            let cur_f = f32::from_bits(cur);
            if local_peak <= cur_f {
                return;
            }
            match slot.compare_exchange_weak(
                cur,
                new_bits,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return,
                Err(actual) => cur = actual,
            }
        }
    }

    /// Atomically take the current peaks and reset the slots to 0. The
    /// emitter thread calls this once per tick. Returns
    /// `(mic_raw_peak, mic_resampled_peak)` as f32 amplitudes in
    /// `[0.0, ~1.0]`.
    pub fn swap_peaks(&self) -> (f32, f32) {
        let raw = f32::from_bits(self.mic_raw_peak_bits.swap(0, Ordering::Relaxed));
        let resampled =
            f32::from_bits(self.mic_resampled_peak_bits.swap(0, Ordering::Relaxed));
        (raw, resampled)
    }

    /// Same as `swap_peaks` but returns dBFS values directly using the
    /// pipeline's standard floor of -120.0. Convenience for the emitter
    /// thread so dbfs conversion stays in one place.
    pub fn swap_dbfs(&self) -> (f32, f32) {
        let (raw, resampled) = self.swap_peaks();
        (dbfs(raw), dbfs(resampled))
    }
}

impl Default for MicLevelStore {
    fn default() -> Self {
        Self::new()
    }
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

/// `webrtc_vad::VadMode` doesn't derive `Debug`. Render a stable
/// human-readable label for the spawn-time log line.
fn vad_mode_label(mode: &VadMode) -> &'static str {
    match mode {
        VadMode::Quality => "quality",
        VadMode::LowBitrate => "low-bitrate",
        VadMode::Aggressive => "aggressive",
        VadMode::VeryAggressive => "very-aggressive",
    }
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

    // --- MicLevelStore --------------------------------------------------

    #[test]
    fn level_store_swap_returns_zero_when_unobserved() {
        let s = MicLevelStore::new();
        let (raw, resampled) = s.swap_peaks();
        assert_eq!(raw, 0.0);
        assert_eq!(resampled, 0.0);
    }

    #[test]
    fn level_store_observe_records_max_abs_peak() {
        let s = MicLevelStore::new();
        s.observe_raw(&[0.1, -0.4, 0.2]);
        s.observe_resampled(&[0.05, 0.7, -0.3]);
        let (raw, resampled) = s.swap_peaks();
        assert!(approx_eq(raw, 0.4), "expected raw=0.4, got {raw}");
        assert!(
            approx_eq(resampled, 0.7),
            "expected resampled=0.7, got {resampled}"
        );
    }

    #[test]
    fn level_store_swap_resets_to_zero() {
        let s = MicLevelStore::new();
        s.observe_raw(&[0.5]);
        let _ = s.swap_peaks();
        let (raw, resampled) = s.swap_peaks();
        assert_eq!(raw, 0.0);
        assert_eq!(resampled, 0.0);
    }

    #[test]
    fn level_store_keeps_max_across_observations_until_swap() {
        let s = MicLevelStore::new();
        s.observe_raw(&[0.3]);
        s.observe_raw(&[0.1]); // smaller — should not overwrite
        s.observe_raw(&[0.6]); // larger — wins
        s.observe_raw(&[0.4]); // smaller again — no change
        let (raw, _) = s.swap_peaks();
        assert!(approx_eq(raw, 0.6), "expected raw=0.6, got {raw}");
    }

    #[test]
    fn level_store_swap_dbfs_uses_minus_120_floor_for_silence() {
        let s = MicLevelStore::new();
        let (raw_db, resampled_db) = s.swap_dbfs();
        // No observations → swap returns 0.0 amp → dbfs → -120.0
        assert!(
            approx_eq(raw_db, -120.0),
            "expected -120.0 dBFS for silence, got {raw_db}"
        );
        assert!(approx_eq(resampled_db, -120.0));
    }

    #[test]
    fn level_store_concurrent_writer_reader_no_leaked_state() {
        // Single writer thread observes random-ish peaks for ~1000
        // iterations; the reader (this thread) drains via swap_peaks
        // on a tight loop. Asserts that:
        //   1. Every drain returns either 0.0 or one of the values
        //      observed since the last drain (no impossible peaks).
        //   2. The post-join final swap is the only reading that may
        //      see the absolute max from the last window.
        //   3. After the writer joins and we drain twice, the second
        //      drain is unconditionally 0.0 (no leaked state).
        use std::sync::Arc;
        use std::thread;

        let store = Arc::new(MicLevelStore::new());
        let writer_store = Arc::clone(&store);

        // Pre-computed deterministic sequence of peaks; using a fixed
        // permutation keeps the test reproducible across runs and CI.
        // Mix of small + large values exercises the CAS-loop branch
        // (small-after-large is a no-op).
        let samples: Vec<f32> = (0..1000)
            .map(|i| ((i * 31 + 7) % 97) as f32 / 100.0) // values in [0, 0.96]
            .collect();
        let max_observed = samples.iter().cloned().fold(0.0f32, f32::max);

        let writer = thread::spawn(move || {
            for s in samples {
                writer_store.observe_raw(&[s]);
                writer_store.observe_resampled(&[s * 0.5]);
            }
        });

        // Reader: drain on a tight loop. Track the largest peak ever
        // observed across drains; it must equal max_observed once the
        // writer is done.
        let mut largest_seen_raw: f32 = 0.0;
        let mut largest_seen_resampled: f32 = 0.0;
        for _ in 0..2000 {
            let (raw, resampled) = store.swap_peaks();
            if raw > largest_seen_raw {
                largest_seen_raw = raw;
            }
            if resampled > largest_seen_resampled {
                largest_seen_resampled = resampled;
            }
        }
        writer.join().expect("writer panicked");

        // Final drain — picks up anything the reader missed.
        let (raw, resampled) = store.swap_peaks();
        if raw > largest_seen_raw {
            largest_seen_raw = raw;
        }
        if resampled > largest_seen_resampled {
            largest_seen_resampled = resampled;
        }

        assert!(
            approx_eq(largest_seen_raw, max_observed),
            "expected largest raw peak = {max_observed}, got {largest_seen_raw}"
        );
        assert!(
            approx_eq(largest_seen_resampled, max_observed * 0.5),
            "expected largest resampled peak = {}, got {largest_seen_resampled}",
            max_observed * 0.5
        );

        // No-leaked-state: a swap immediately after the previous drain
        // must return exactly 0.0 since no observations have happened
        // in between.
        let (raw_after, resampled_after) = store.swap_peaks();
        assert_eq!(raw_after, 0.0);
        assert_eq!(resampled_after, 0.0);
    }
}
