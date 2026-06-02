//! Windows-specific audio capture impls.
//!
//! Mic capture is shared with macOS via `audio::cpal_mic` (cpal sits on
//! WASAPI under the hood on Windows). The genuinely Windows-specific
//! bit is system loopback capture — cpal does not expose
//! `AUDCLNT_STREAMFLAGS_LOOPBACK`, so we drive WASAPI directly through
//! the `wasapi` crate.
//!
//! The permission surface mirrors `audio::macos::permissions` but is a
//! no-op: WASAPI loopback never prompts, and Windows mic access is
//! gated by the OS Settings panel rather than an in-process API.

pub mod permissions;
pub mod system;
