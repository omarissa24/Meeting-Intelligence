//! ScreenCaptureKit-backed `SystemSource` — captures the system audio
//! mix (everything an app would render to the speakers, minus what
//! `SCContentFilter` excludes).
//!
//! Configured for **16 kHz mono Float32** at the SCStream level so the
//! pipeline doesn't need to resample this path. The crate's own
//! `stream/configuration/audio.rs` confirms 16 kHz is a supported native
//! rate, alongside 8/24/48.
//!
//! Threading: SCStream invokes `did_output_sample_buffer` on its own
//! audio queue. We extract the f32 samples, build an `AudioFrame`, and
//! push to the worker via `SyncSender::try_send`. On a full channel we
//! drop the frame and bump `dropped_frames` — the pipeline reports the
//! counter to the UI via the periodic stats event.
//!
//! Lifetime: `start` builds and starts an `SCStream`; `stop` calls
//! `stop_capture` and drops the handle. Re-`start` is allowed only after
//! a successful `stop`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use screencapturekit::cm::CMSampleBufferExt;
use screencapturekit::prelude::*;

use crate::audio::traits::{
    AudioFormat, AudioFrame, SampleFormat, SourceCounters, SourceError, SourceKind, SystemSource,
};

/// Match what we configure on `SCStreamConfiguration` below. Kept as
/// constants rather than fields because the SCStream rate enum only
/// supports a fixed set of values (8/16/24/48 kHz) — see
/// `stream/configuration/audio.rs::AudioSampleRate`.
const SAMPLE_RATE: u32 = 16_000;
const CHANNELS: u16 = 1;

/// Default ceiling for backpressure drops we tolerate before we surface
/// an error event. The pipeline can override via `with_drop_threshold`
/// once it lands; this is a sensible starting point (~5 s of dropped audio
/// at SCKit's typical buffer cadence).
const DEFAULT_DROP_LOG_THRESHOLD: u64 = 250;

pub struct SCKitSystemSource {
    /// Live SCStream while running; `None` between sessions. We hold the
    /// stream behind a Mutex so `stop` can call `stop_capture` from the
    /// command thread while the audio queue might still be flushing.
    stream: Mutex<Option<SCStream>>,
    /// Total frames the audio handler has tried to enqueue.
    received: Arc<AtomicU64>,
    /// Frames dropped because the worker channel was full.
    dropped: Arc<AtomicU64>,
    /// Threshold at which the source logs a warning to stderr. Doesn't
    /// stop the source — the controller may decide to surface this to
    /// the UI as an `audio://error`.
    drop_log_threshold: u64,
}

impl SCKitSystemSource {
    pub fn new() -> Self {
        Self {
            stream: Mutex::new(None),
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

impl Default for SCKitSystemSource {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemSource for SCKitSystemSource {
    fn start(&mut self, sink: SyncSender<AudioFrame>) -> Result<(), SourceError> {
        let mut guard = self
            .stream
            .lock()
            .map_err(|e| SourceError::Platform(format!("stream mutex poisoned: {e}")))?;
        if guard.is_some() {
            return Err(SourceError::AlreadyRunning);
        }

        // Pick any display — content filter is required, but we discard
        // the screen frames in the no-op video handler below.
        let content =
            SCShareableContent::get().map_err(|e| SourceError::Platform(format!("{e:?}")))?;
        let display = content
            .displays()
            .into_iter()
            .next()
            .ok_or(SourceError::DeviceUnavailable("no displays".into()))?;
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();

        let config = SCStreamConfiguration::new()
            .with_width(640)
            .with_height(360)
            .with_captures_audio(true)
            .with_sample_rate(SAMPLE_RATE as i32)
            .with_channel_count(CHANNELS as i32);

        let mut stream = SCStream::new(&filter, &config);

        // SCStream requires at least one frame handler. We don't care
        // about pixels here, so register a no-op for screen output.
        stream.add_output_handler(NoopVideo, SCStreamOutputType::Screen);

        let handler = AudioHandler {
            sink,
            received: self.received.clone(),
            dropped: self.dropped.clone(),
            drop_log_threshold: self.drop_log_threshold,
        };
        stream.add_output_handler(handler, SCStreamOutputType::Audio);

        stream
            .start_capture()
            .map_err(|e| SourceError::Platform(format!("start_capture: {e:?}")))?;

        *guard = Some(stream);
        Ok(())
    }

    fn stop(&mut self) -> Result<(), SourceError> {
        let mut guard = self
            .stream
            .lock()
            .map_err(|e| SourceError::Platform(format!("stream mutex poisoned: {e}")))?;
        let mut stream = guard.take().ok_or(SourceError::NotRunning)?;
        stream
            .stop_capture()
            .map_err(|e| SourceError::Platform(format!("stop_capture: {e:?}")))?;
        // Drop happens on scope exit — releases the SCStream + its handlers.
        Ok(())
    }

    fn native_format(&self) -> AudioFormat {
        AudioFormat {
            sample_rate: SAMPLE_RATE,
            channels: CHANNELS,
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

/// SCStream needs a handler registered for screen output even when we
/// only want audio. The crate quietly drops samples for output types
/// that have no handler attached.
struct NoopVideo;
impl SCStreamOutputTrait for NoopVideo {
    fn did_output_sample_buffer(&self, _sample: CMSampleBuffer, _of_type: SCStreamOutputType) {}
}

struct AudioHandler {
    sink: SyncSender<AudioFrame>,
    received: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    drop_log_threshold: u64,
}

impl SCStreamOutputTrait for AudioHandler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
        if of_type != SCStreamOutputType::Audio {
            return;
        }

        let Some(list) = sample.audio_buffer_list() else {
            return;
        };

        // SCStream typically emits one interleaved buffer per callback; we
        // still iterate to be safe and concatenate.
        let mut samples: Vec<f32> = Vec::new();
        for buf in list.iter() {
            let bytes = buf.data();
            match bytemuck::try_cast_slice::<u8, f32>(bytes) {
                Ok(s) => samples.extend_from_slice(s),
                Err(_) => {
                    // Misaligned / unexpected layout — bail rather than
                    // emit garbage. Bump the dropped counter so the
                    // pipeline can decide what to surface.
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            }
        }
        if samples.is_empty() {
            return;
        }

        let pts_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);

        let frame = AudioFrame {
            kind: SourceKind::System,
            samples,
            format: AudioFormat {
                sample_rate: SAMPLE_RATE,
                channels: CHANNELS,
                format: SampleFormat::F32Interleaved,
            },
            pts_ns,
        };

        match self.sink.try_send(frame) {
            Ok(()) => {
                self.received.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Full(_)) => {
                let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if n == self.drop_log_threshold {
                    eprintln!(
                        "audio/system: worker channel full; {n} system-audio frames dropped"
                    );
                }
            }
            Err(TrySendError::Disconnected(_)) => {
                // Worker has gone away. Bump dropped so stop_capture
                // doesn't see a divergence; nothing else to do here.
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}
