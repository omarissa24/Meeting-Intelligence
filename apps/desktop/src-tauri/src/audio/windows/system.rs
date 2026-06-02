//! WASAPI loopback `SystemSource` — captures whatever the default render
//! device is currently playing (system mix), converts it to canonical
//! 16 kHz mono F32, and pushes `AudioFrame`s to the worker.
//!
//! ## Why a dedicated thread instead of a callback
//!
//! WASAPI's capture API is pull-based: the application owns the loop and
//! drains the device's ring buffer with `read_from_device`. The loop must
//! run on a thread that has called `CoInitializeEx(COINIT_MULTITHREADED)`,
//! so we own the thread and the COM apartment. Stop signaling is via an
//! `AtomicBool`; the loop checks it between event-wakeups.
//!
//! ## Loopback in wasapi 0.23
//!
//! There is no `LoopbackPoll` or `LoopbackEvents` variant on `StreamMode`.
//! Per the crate's own example (examples/record.rs in v0.23), system-wide
//! loopback is configured by selecting the **Render** endpoint and then
//! initializing it in **Capture** direction. The OS engine mixes the
//! application's request into the existing render stream.
//!
//! ## Format conversion
//!
//! WASAPI shared-mode loopback hands us audio in the device's native mix
//! format — typically 48 kHz stereo IEEE float, but the device decides.
//! We pass `autoconvert: true` to `EventsShared` so the OS resamples to
//! whatever WAVEFORMAT we requested. We could in theory ask the OS for
//! 16 kHz mono directly, but that mixes our quality with whatever the
//! WASAPI mixer feels like; instead we capture at the device's mix
//! format (richer signal, no double-resample) and run the same rubato
//! pipeline the mic path uses.
//!
//! Conversion inside the source:
//!   1. **Multi-channel → mono**: average all channels per sample.
//!   2. **Native rate → 16 kHz**: drive a single `SourceResampler`,
//!      which buffers internally and emits 320-sample chunks.

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode};

use crate::audio::resampler::{SourceResampler, TARGET_RATE};
use crate::audio::traits::{
    AudioFormat, AudioFrame, SampleFormat, SourceCounters, SourceError, SourceKind, SystemSource,
};

const TARGET_CHANNELS: u16 = 1;
/// Same drop-log threshold used by the macOS source for parity.
const DEFAULT_DROP_LOG_THRESHOLD: u64 = 250;
/// Max wait for an event-driven WASAPI buffer wakeup, in milliseconds.
/// Three seconds matches the upstream `record.rs` example. Longer than
/// any reasonable WASAPI period; if we hit it the device is stuck and
/// we surface that as an error.
const EVENT_WAIT_MS: u32 = 3000;
/// How often we check the stop flag inside the capture loop. Set to
/// the same scale as a single WASAPI period so stop latency is one
/// device period in the worst case.
const STOP_CHECK_MS: u32 = 200;

pub struct WasapiSystemSource {
    /// Set to `true` by `stop()`; the worker thread checks it on each
    /// loop iteration and exits cleanly.
    stop_flag: Arc<AtomicBool>,
    /// Handle to the worker thread. Held behind a Mutex so we can take
    /// it out on stop without making the source itself non-`Send`.
    worker: Mutex<Option<JoinHandle<()>>>,
    received: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    drop_log_threshold: u64,
}

impl WasapiSystemSource {
    pub fn new() -> Self {
        Self {
            stop_flag: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
            received: Arc::new(AtomicU64::new(0)),
            dropped: Arc::new(AtomicU64::new(0)),
            drop_log_threshold: DEFAULT_DROP_LOG_THRESHOLD,
        }
    }

    pub fn received_frames(&self) -> u64 {
        self.received.load(Ordering::Relaxed)
    }

    pub fn dropped_frames(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

impl Default for WasapiSystemSource {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemSource for WasapiSystemSource {
    fn start(&mut self, sink: SyncSender<AudioFrame>) -> Result<(), SourceError> {
        let mut guard = self
            .worker
            .lock()
            .map_err(|e| SourceError::Platform(format!("worker mutex poisoned: {e}")))?;
        if guard.is_some() {
            return Err(SourceError::AlreadyRunning);
        }

        // Probe synchronously so a missing/unavailable device fails the
        // start_recording IPC rather than silently dying inside the
        // worker. The worker re-initializes COM on its own apartment
        // because that's the apartment that owns the live audio client.
        probe_default_render_device()?;

        self.stop_flag.store(false, Ordering::Relaxed);
        let stop_flag = self.stop_flag.clone();
        let received = self.received.clone();
        let dropped = self.dropped.clone();
        let drop_log_threshold = self.drop_log_threshold;
        let sink_clone = sink.clone();

        let handle = std::thread::Builder::new()
            .name("audio-system".into())
            .spawn(move || {
                if let Err(e) = run_capture_loop(
                    sink_clone,
                    stop_flag,
                    received,
                    dropped,
                    drop_log_threshold,
                ) {
                    eprintln!("audio/system(windows): worker exited with error: {e}");
                }
            })
            .map_err(|e| SourceError::Platform(format!("spawn audio-system thread: {e}")))?;

        *guard = Some(handle);
        Ok(())
    }

    fn stop(&mut self) -> Result<(), SourceError> {
        let mut guard = self
            .worker
            .lock()
            .map_err(|e| SourceError::Platform(format!("worker mutex poisoned: {e}")))?;
        let handle = guard.take().ok_or(SourceError::NotRunning)?;
        self.stop_flag.store(true, Ordering::Relaxed);
        // Joining is best-effort. If the worker has already exited
        // because the audio device was unplugged mid-session, `join`
        // returns Ok regardless. We surface a Platform error only if
        // the thread itself panicked.
        handle
            .join()
            .map_err(|_| SourceError::Platform("audio-system worker panicked".into()))?;
        Ok(())
    }

    fn native_format(&self) -> AudioFormat {
        // The pipeline expects system frames to be 16 kHz mono F32 (see
        // pipeline.rs:287-294). We convert inside the worker before
        // emitting the frame, so the format we *promise* the pipeline
        // is the canonical one even though WASAPI hands us something
        // device-specific.
        AudioFormat {
            sample_rate: TARGET_RATE,
            channels: TARGET_CHANNELS,
            format: SampleFormat::F32Interleaved,
        }
    }

    fn counters(&self) -> SourceCounters {
        SourceCounters {
            received: self.received_frames(),
            dropped: self.dropped_frames(),
        }
    }
}

/// Pre-flight check: confirm the default render endpoint is reachable
/// before we spawn the worker thread. Initializes COM on the calling
/// thread; the worker re-initializes on its own thread.
fn probe_default_render_device() -> Result<(), SourceError> {
    initialize_mta()
        .ok()
        .map_err(|e| SourceError::Platform(format!("CoInitializeEx (probe): {e:?}")))?;
    let enumerator = DeviceEnumerator::new()
        .map_err(|e| SourceError::Platform(format!("DeviceEnumerator::new: {e:?}")))?;
    let _device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| {
            SourceError::DeviceUnavailable(format!("no default render device: {e:?}"))
        })?;
    Ok(())
}

/// Owned by the worker thread. Sets up COM, the loopback client, and
/// the conversion pipeline; loops draining the device until
/// `stop_flag` is set.
fn run_capture_loop(
    sink: SyncSender<AudioFrame>,
    stop_flag: Arc<AtomicBool>,
    received: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    drop_log_threshold: u64,
) -> Result<(), String> {
    initialize_mta()
        .ok()
        .map_err(|e| format!("CoInitializeEx (worker): {e:?}"))?;

    let enumerator = DeviceEnumerator::new()
        .map_err(|e| format!("DeviceEnumerator::new: {e:?}"))?;
    // Loopback: pick the *Render* endpoint, but initialize the client
    // for *Capture*. The OS engine mixes the active render stream into
    // our capture buffer.
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| format!("get_default_device(Render): {e:?}"))?;
    let device_name = device
        .get_friendlyname()
        .unwrap_or_else(|_| "<unknown>".into());

    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| format!("get_iaudioclient: {e:?}"))?;

    let mix_format = audio_client
        .get_mixformat()
        .map_err(|e| format!("get_mixformat: {e:?}"))?;
    let native_rate = mix_format.get_samplespersec();
    let native_channels = mix_format.get_nchannels();
    let bits = mix_format.get_bitspersample();
    let block_align = mix_format.get_blockalign();
    let sample_type = mix_format
        .get_subformat()
        .map_err(|e| format!("get_subformat: {e:?}"))?;

    eprintln!(
        "audio/system(windows): device='{device_name}' rate={native_rate} channels={native_channels} bits={bits} format={:?}",
        sample_type
    );

    let (_default_period, min_period) = audio_client
        .get_device_period()
        .map_err(|e| format!("get_device_period: {e:?}"))?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    audio_client
        .initialize_client(&mix_format, &Direction::Capture, &mode)
        .map_err(|e| format!("initialize_client(loopback): {e:?}"))?;

    let event_handle = audio_client
        .set_get_eventhandle()
        .map_err(|e| format!("set_get_eventhandle: {e:?}"))?;

    let capture = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("get_audiocaptureclient: {e:?}"))?;

    let buffer_frame_count = audio_client
        .get_buffer_size()
        .map_err(|e| format!("get_buffer_size: {e:?}"))?;

    audio_client
        .start_stream()
        .map_err(|e| format!("start_stream: {e:?}"))?;

    // Resampler converts native_rate → 16 kHz. Bypass it entirely if
    // the device already runs at 16 kHz (rare on Windows; saves the
    // rubato cost per chunk).
    let mut resampler = if native_rate == TARGET_RATE {
        None
    } else {
        Some(
            SourceResampler::new(native_rate)
                .map_err(|e| format!("construct resampler @ {native_rate}Hz: {e}"))?,
        )
    };

    // Reusable scratch buffer for raw bytes. Sized to the device's full
    // ring-buffer capacity so a single `read_from_device` call cannot
    // outrun us. The wasapi crate documents truncation when the buffer
    // is too small.
    let scratch_capacity = block_align as usize * (buffer_frame_count as usize + 1024);
    let mut byte_scratch = vec![0u8; scratch_capacity];

    // Per-iteration buffers, reused to avoid allocation churn.
    let mut mono_native: Vec<f32> = Vec::with_capacity(native_rate as usize / 10);
    let mut canonical: Vec<f32> = Vec::with_capacity(TARGET_RATE as usize / 10);

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        // Wake on the WASAPI capture event. We use a short timeout so
        // we re-check the stop flag often — that bounds how long stop()
        // blocks the IPC thread on the join() call. A genuine event
        // timeout (no device activity for STOP_CHECK_MS) is normal when
        // nothing is playing; we just retry.
        match event_handle.wait_for_event(STOP_CHECK_MS) {
            Ok(()) => {}
            Err(_) => {
                // Timeout: nothing playing right now, loop back and
                // re-check the stop flag.
                continue;
            }
        }

        let (frames_read, _info) = capture
            .read_from_device(&mut byte_scratch[..])
            .map_err(|e| format!("read_from_device: {e:?}"))?;

        if frames_read == 0 {
            continue;
        }

        let bytes_read = frames_read as usize * block_align as usize;
        if bytes_read == 0 || bytes_read > byte_scratch.len() {
            // Defensive: shouldn't happen, but if WASAPI lies about the
            // frame count, drop this read rather than slice OOB.
            dropped.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        let raw = &byte_scratch[..bytes_read];

        // Interpret raw bytes as f32 / i16 depending on the device mix
        // format. Modern Windows almost always reports SampleType::Float
        // at 32 bits; we honor int paths too so a quirky device gets a
        // clean pipeline rather than garbled audio.
        mono_native.clear();
        match (sample_type, bits) {
            (SampleType::Float, 32) => {
                let interleaved: &[f32] = match bytemuck::try_cast_slice::<u8, f32>(raw) {
                    Ok(s) => s,
                    Err(_) => {
                        dropped.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                };
                downmix_to_mono(interleaved, native_channels, &mut mono_native);
            }
            (SampleType::Int, 16) => {
                let interleaved: &[i16] = match bytemuck::try_cast_slice::<u8, i16>(raw) {
                    Ok(s) => s,
                    Err(_) => {
                        dropped.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                };
                downmix_i16_to_mono(interleaved, native_channels, &mut mono_native);
            }
            (st, b) => {
                return Err(format!(
                    "unsupported WASAPI mix format: {st:?} @ {b} bits"
                ));
            }
        }

        // Native rate → 16 kHz. The resampler buffers internally across
        // calls; we collect every emitted 320-sample chunk into
        // `canonical` and emit a single AudioFrame per WASAPI read so
        // the worker channel sees coarse-grained frames.
        canonical.clear();
        if let Some(r) = resampler.as_mut() {
            r.push_and_drain(&mono_native, |chunk| canonical.extend_from_slice(chunk))
                .map_err(|e| format!("resampler.push_and_drain: {e}"))?;
        } else {
            canonical.extend_from_slice(&mono_native);
        }

        if canonical.is_empty() {
            // Sub-chunk read — wait for the next iteration to fill enough
            // input for the resampler to emit.
            continue;
        }

        let pts_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);

        let frame = AudioFrame {
            kind: SourceKind::System,
            samples: canonical.clone(),
            format: AudioFormat {
                sample_rate: TARGET_RATE,
                channels: TARGET_CHANNELS,
                format: SampleFormat::F32Interleaved,
            },
            pts_ns,
        };

        match sink.try_send(frame) {
            Ok(()) => {
                received.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Full(_)) => {
                let n = dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if n == drop_log_threshold {
                    eprintln!(
                        "audio/system(windows): worker channel full; {n} system-audio frames dropped"
                    );
                }
            }
            Err(TrySendError::Disconnected(_)) => {
                // Pipeline has been torn down — exit cleanly.
                break;
            }
        }
    }

    let _ = audio_client.stop_stream();
    // Silence unused-var: kept for parity with the upstream example,
    // and useful if we ever want to surface a "device buffer too small"
    // diagnostic.
    let _ = EVENT_WAIT_MS;
    Ok(())
}

/// Average all channels of an interleaved f32 buffer into a mono Vec.
/// `channels == 1` is a fast-path passthrough.
fn downmix_to_mono(interleaved: &[f32], channels: u16, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let ch = channels as usize;
    let scale = 1.0 / ch as f32;
    out.reserve(interleaved.len() / ch);
    for frame in interleaved.chunks_exact(ch) {
        let mut sum = 0.0f32;
        for &s in frame {
            sum += s;
        }
        out.push(sum * scale);
    }
}

/// i16 variant: convert to f32 in [-1.0, 1.0] while downmixing.
fn downmix_i16_to_mono(interleaved: &[i16], channels: u16, out: &mut Vec<f32>) {
    let ch = channels as usize;
    out.reserve(interleaved.len() / ch.max(1));
    if ch <= 1 {
        for &s in interleaved {
            out.push(s as f32 / i16::MAX as f32);
        }
        return;
    }
    let scale = 1.0 / (i16::MAX as f32 * ch as f32);
    for frame in interleaved.chunks_exact(ch) {
        let mut sum = 0.0f32;
        for &s in frame {
            sum += s as f32;
        }
        out.push(sum * scale);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_passthrough_for_mono() {
        let mut out = Vec::new();
        downmix_to_mono(&[0.1, 0.2, 0.3], 1, &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn downmix_averages_stereo_frames() {
        // Two stereo frames: (1.0, -1.0) → 0.0; (0.5, 0.5) → 0.5
        let mut out = Vec::new();
        downmix_to_mono(&[1.0, -1.0, 0.5, 0.5], 2, &mut out);
        assert_eq!(out.len(), 2);
        assert!(out[0].abs() < 1e-6);
        assert!((out[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn downmix_handles_5_1_layout() {
        // 6-channel frame: all 1.0 → mono 1.0.
        let frame: Vec<f32> = vec![1.0; 6];
        let mut out = Vec::new();
        downmix_to_mono(&frame, 6, &mut out);
        assert_eq!(out.len(), 1);
        assert!((out[0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn downmix_drops_partial_trailing_frame() {
        // 3 samples for a stereo layout = 1 full frame + 1 dangling
        // sample. chunks_exact silently drops the dangling sample.
        let mut out = Vec::new();
        downmix_to_mono(&[1.0, -1.0, 0.5], 2, &mut out);
        assert_eq!(out.len(), 1);
        assert!(out[0].abs() < 1e-6);
    }

    #[test]
    fn downmix_i16_normalizes_to_unit_range() {
        let mut out = Vec::new();
        downmix_i16_to_mono(&[i16::MAX, i16::MAX], 2, &mut out);
        assert_eq!(out.len(), 1);
        assert!((out[0] - 1.0).abs() < 1e-3);
    }

    /// Drives the conversion path end-to-end without hitting WASAPI.
    /// Confirms that 48 kHz stereo → 16 kHz mono produces 320-sample
    /// chunks the way the pipeline expects.
    #[test]
    fn resample_pipeline_emits_320_sample_chunks() {
        use crate::audio::resampler::FIXED_OUTPUT_FRAMES;

        let mut r = SourceResampler::new(48_000).expect("construct");
        // 1 s of 48 kHz stereo (96k samples), all silence.
        let stereo: Vec<f32> = vec![0.0; 96_000];
        let mut mono = Vec::new();
        downmix_to_mono(&stereo, 2, &mut mono);
        assert_eq!(mono.len(), 48_000);

        let mut chunks = 0usize;
        r.push_and_drain(&mono, |chunk| {
            chunks += 1;
            assert_eq!(chunk.len(), FIXED_OUTPUT_FRAMES);
        })
        .expect("push_and_drain");
        assert!(chunks > 0, "expected at least one 320-sample chunk");
    }
}
