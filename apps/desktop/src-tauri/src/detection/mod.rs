//! Automatic meeting detection (Phase 6).
//!
//! Watches two local signals — is a known conferencing app running, and is the
//! microphone in use — and emits `meeting://detected` / `meeting://ended` so
//! the frontend can offer "start recording?". Everything here is **local
//! only**: no audio, no signal, and no detection event ever leaves the device
//! or touches the FastAPI backend. This is intentionally NOT a LangGraph node
//! — that orchestration invariant is a backend concern; do not route detection
//! through the backend graph.
//!
//! Layout:
//!   traits.rs      — `DetectionSource` trait + `RawSignals` (the swappable seam)
//!   apps.rs        — registry of known conferencing apps (bundle id / process)
//!   monitor.rs     — pure `DetectionFsm` (debounce/edge) + poll-thread driver
//!   macos/source.rs   — NSWorkspace app enum + CoreAudio mic-active read
//!   windows/source.rs — sysinfo process enum + ConsentStore registry read
//!
//! Compiled on macOS and Windows only (mirrors `recording`). The macOS source
//! is the verified path; the Windows source is code-complete behind the same
//! trait, awaiting real-hardware UAT (same staging as the WASAPI system
//! source).

#![cfg(any(target_os = "macos", target_os = "windows"))]
// The suppress/snooze surface and a few helpers are public for the command
// layer; allow dead_code so platform-specific gaps don't warn.
#![allow(dead_code)]

pub mod apps;
pub mod monitor;
pub mod traits;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use crate::detection::traits::DetectionSource;

/// Construct the platform signal source. Cheap — holds no OS handles; the
/// monitor creates one per `start_detection`.
pub fn new_source() -> Box<dyn DetectionSource> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::source::MacosDetectionSource::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::source::WindowsDetectionSource::new())
    }
}
