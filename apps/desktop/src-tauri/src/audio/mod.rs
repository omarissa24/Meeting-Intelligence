//! Audio capture pipeline.
//!
//! Layout (matches plan `~/.claude/plans/zippy-meandering-bachman.md`):
//!   traits.rs      — MicSource / SystemSource / AudioFrame contracts
//!   macos/system.rs— ScreenCaptureKit-backed SystemSource (this slice)
//!   macos/mic.rs   — cpal-backed MicSource (next slice)
//!   resampler.rs   — rubato wrapper, fixed 320-sample output
//!   mixer.rs       — two-stream alignment + sum-and-clip
//!   vad.rs         — webrtc-vad gate, 20 ms i16 frames
//!   encoder.rs     — f32 -> i16 LE, 1 s framing, base64
//!   pipeline.rs    — worker thread orchestrator
//!
//! Only `traits` and the macOS sources land in this commit; the rest follow
//! in subsequent slices once the spike has confirmed SCKit gives us f32 PCM.

pub mod encoder;
pub mod mixer;
pub mod pipeline;
pub mod resampler;
pub mod traits;
pub mod vad;

#[cfg(target_os = "macos")]
pub mod macos;
