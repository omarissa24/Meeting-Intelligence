//! cpal-backed `MicSource` — opens the default input device and pushes
//! `AudioFrame`s to the worker. cpal abstracts CoreAudio on macOS and
//! WASAPI on Windows; both surface a `Send`-able `Stream` handle, so the
//! same implementation works on both platforms.
//!
//! cpal's data callback runs on a dedicated audio thread (per
//! `host/coreaudio/macos/mod.rs:112` — "the dedicated thread architecture
//! ensures `Stream` can implement `Send`"; the WASAPI host is structured
//! the same way), so we can store the `Stream` handle directly behind a
//! Mutex and call `pause()` from the command thread on stop.
//!
//! We pick the device's first supported input config and request its max
//! sample rate — the resampler downstream handles whatever rate cpal
//! gives us. cpal's `&[f32]` callback is interleaved across channels, so
//! we emit the frame at its native rate/channel count and let the
//! pipeline downmix + resample.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{InputCallbackInfo, SampleFormat as CpalSampleFormat, Stream, StreamConfig};

use crate::audio::traits::{
    AudioFormat, AudioFrame, MicSource, SampleFormat, SourceCounters, SourceError, SourceKind,
};

const DEFAULT_DROP_LOG_THRESHOLD: u64 = 250;

pub struct CpalMicSource {
    /// Live cpal Stream while running; `None` between sessions. cpal
    /// `Stream` is `Send` on macOS (see module docs) so this lives
    /// safely behind a Mutex even though the audio callback fires on
    /// a CoreAudio thread.
    stream: Mutex<Option<Stream>>,
    /// Captured at start; the resampler/mixer reads `native_format()`
    /// to size its buffers.
    captured_format: Mutex<Option<AudioFormat>>,
    received: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    drop_log_threshold: u64,
}

impl CpalMicSource {
    pub fn new() -> Self {
        Self {
            stream: Mutex::new(None),
            captured_format: Mutex::new(None),
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

    fn pick_config(
        device: &cpal::Device,
    ) -> Result<(StreamConfig, CpalSampleFormat), SourceError> {
        // Pick the first supported input config and use its max sample
        // rate. macOS default input is almost always Float32 already; we
        // still validate the format and surface a clear error if the
        // device only offers integer formats (we'd need a separate
        // f32-conversion path, which we'll add when WASAPI lands).
        let mut configs = device
            .supported_input_configs()
            .map_err(|e| SourceError::DeviceUnavailable(format!("supported_input_configs: {e}")))?;
        let cfg = configs
            .next()
            .ok_or_else(|| SourceError::DeviceUnavailable("no supported input configs".into()))?
            .with_max_sample_rate();

        let sample_format = cfg.sample_format();
        if sample_format != CpalSampleFormat::F32 {
            return Err(SourceError::Platform(format!(
                "mic device exposes {sample_format:?}; only F32 supported in this slice"
            )));
        }
        Ok((cfg.into(), sample_format))
    }
}

impl Default for CpalMicSource {
    fn default() -> Self {
        Self::new()
    }
}

impl MicSource for CpalMicSource {
    fn start(&mut self, sink: SyncSender<AudioFrame>) -> Result<(), SourceError> {
        let mut guard = self
            .stream
            .lock()
            .map_err(|e| SourceError::Platform(format!("stream mutex poisoned: {e}")))?;
        if guard.is_some() {
            return Err(SourceError::AlreadyRunning);
        }

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| SourceError::DeviceUnavailable("no default input device".into()))?;
        // `name()` is deprecated in favor of `description()` / `id()`, but the
        // newer methods aren't on the trait yet at our pinned cpal version.
        // Silence the warning at the call site rather than across the file.
        #[allow(deprecated)]
        let device_name = device.name().unwrap_or_else(|_| "<unknown>".into());
        let (config, _format) = Self::pick_config(&device)?;

        // Log the cpal config we ended up with so the operator can see
        // exactly what the device reported (rate + channel count). With
        // a stereo or aggregate device, the channel count drives a
        // downstream downmix that divides by N — which can attenuate
        // the signal if N > 1 channels are populated identically.
        eprintln!(
            "audio/mic: opening device='{device_name}' rate={} channels={}",
            config.sample_rate, config.channels,
        );

        let format = AudioFormat {
            sample_rate: config.sample_rate,
            channels: config.channels,
            format: SampleFormat::F32Interleaved,
        };
        *self
            .captured_format
            .lock()
            .map_err(|e| SourceError::Platform(format!("format mutex poisoned: {e}")))? =
            Some(format);

        let received = self.received.clone();
        let dropped = self.dropped.clone();
        let log_threshold = self.drop_log_threshold;

        let data_cb = move |samples: &[f32], _info: &InputCallbackInfo| {
            if samples.is_empty() {
                return;
            }
            let pts_ns = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            let frame = AudioFrame {
                kind: SourceKind::Mic,
                samples: samples.to_vec(),
                format,
                pts_ns,
            };
            match sink.try_send(frame) {
                Ok(()) => {
                    received.fetch_add(1, Ordering::Relaxed);
                }
                Err(TrySendError::Full(_)) => {
                    let n = dropped.fetch_add(1, Ordering::Relaxed) + 1;
                    if n == log_threshold {
                        eprintln!(
                            "audio/mic: worker channel full; {n} mic frames dropped"
                        );
                    }
                }
                Err(TrySendError::Disconnected(_)) => {
                    dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        };

        let err_cb = |err: cpal::StreamError| {
            eprintln!("audio/mic: stream error: {err}");
        };

        let stream = device
            .build_input_stream(&config, data_cb, err_cb, None)
            .map_err(|e| SourceError::Platform(format!("build_input_stream: {e}")))?;
        stream
            .play()
            .map_err(|e| SourceError::Platform(format!("stream.play: {e}")))?;

        *guard = Some(stream);
        Ok(())
    }

    fn stop(&mut self) -> Result<(), SourceError> {
        let mut guard = self
            .stream
            .lock()
            .map_err(|e| SourceError::Platform(format!("stream mutex poisoned: {e}")))?;
        let stream = guard.take().ok_or(SourceError::NotRunning)?;
        // `pause` halts callbacks; dropping the Stream releases the
        // CoreAudio AudioUnit. Both happen on this scope exit.
        stream
            .pause()
            .map_err(|e| SourceError::Platform(format!("stream.pause: {e}")))?;
        drop(stream);
        Ok(())
    }

    fn native_format(&self) -> AudioFormat {
        // Before start, callers don't know the rate yet; report a
        // sentinel format. Once start has run, we report the captured
        // value. This mirrors how CoreAudio surfaces device formats
        // only after the AudioUnit is configured.
        self.captured_format
            .lock()
            .ok()
            .and_then(|g| *g)
            .unwrap_or(AudioFormat {
                sample_rate: 0,
                channels: 0,
                format: SampleFormat::F32Interleaved,
            })
    }

    fn counters(&self) -> SourceCounters {
        SourceCounters {
            received: self.received_frames(),
            dropped: self.dropped_frames(),
        }
    }
}
