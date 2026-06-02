//! macOS-specific audio capture impls. Built only for macOS; the rest of the
//! audio pipeline (resampler/mixer/vad/encoder/pipeline) is platform-neutral
//! and stays under `audio/`.
//!
//! Mic capture itself is shared with Windows via `audio::cpal_mic` —
//! both platforms drive cpal, just on different host APIs (CoreAudio
//! vs WASAPI). This module covers only the macOS-specific bits:
//! ScreenCaptureKit-based system loopback and the macOS permission flow.

pub mod permissions;
pub mod system;
