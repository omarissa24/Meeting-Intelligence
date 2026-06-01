//! Platform-agnostic audio capture contracts.
//!
//! `MicSource` and `SystemSource` exist so the Windows WASAPI implementation
//! can drop in later behind the same trait without touching the pipeline. The
//! macOS impls live under `audio::macos`.
//!
//! `AudioFrame` is the unit of data the worker thread consumes. Sources push
//! frames into a `SyncSender<AudioFrame>` from whichever thread the platform
//! API mandates (CoreAudio for cpal, SCStream's audio queue for ScreenCaptureKit).
//! The worker is a single consumer.

use std::sync::mpsc::SyncSender;

/// Sample format we accept from sources. ScreenCaptureKit hands us f32 already;
/// cpal's mic stream is also typically f32 on macOS. Keeping the union narrow
/// means the resampler/mixer don't need a polymorphic input type.
#[derive(Debug, Clone, Copy)]
pub enum SampleFormat {
    F32Interleaved,
}

#[derive(Debug, Clone, Copy)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub format: SampleFormat,
}

/// Identifies which source produced a frame. The pipeline routes by
/// kind: mic frames go through resampler+downmix, system frames go
/// straight to the mixer (already 16 kHz mono).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Mic,
    System,
}

/// One callback's worth of samples. `samples` are interleaved per `format`.
/// `pts_ns` is whatever monotonic timestamp the source provides — used by
/// the mixer for cross-stream alignment, not for wall-clock display.
#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub kind: SourceKind,
    pub samples: Vec<f32>,
    pub format: AudioFormat,
    pub pts_ns: u64,
}

/// Errors a source can surface to the controller. Kept coarse on purpose —
/// the UI only cares whether the source is alive.
#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("permission denied: {0}")]
    PermissionDenied(&'static str),
    #[error("device unavailable: {0}")]
    DeviceUnavailable(String),
    #[error("source already running")]
    AlreadyRunning,
    #[error("source not running")]
    NotRunning,
    #[error("platform error: {0}")]
    Platform(String),
}

/// Frames received vs frames dropped at a source's edge. Reported on
/// stop and used by the periodic stats event.
#[derive(Debug, Clone, Copy, Default)]
pub struct SourceCounters {
    pub received: u64,
    pub dropped: u64,
}

/// Microphone capture (cpal-backed on macOS in a later slice).
pub trait MicSource: Send {
    fn start(&mut self, sink: SyncSender<AudioFrame>) -> Result<(), SourceError>;
    fn stop(&mut self) -> Result<(), SourceError>;
    /// What rate / channel count the source emits before the resampler.
    fn native_format(&self) -> AudioFormat;
    fn counters(&self) -> SourceCounters;
}

/// System (loopback) capture. macOS uses ScreenCaptureKit; Windows will use
/// WASAPI loopback later behind the same trait.
pub trait SystemSource: Send {
    fn start(&mut self, sink: SyncSender<AudioFrame>) -> Result<(), SourceError>;
    fn stop(&mut self) -> Result<(), SourceError>;
    fn native_format(&self) -> AudioFormat;
    fn counters(&self) -> SourceCounters;
}
