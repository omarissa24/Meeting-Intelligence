//! Platform-agnostic meeting-detection contracts.
//!
//! `DetectionSource` is the swappable seam (mirrors `audio::traits::MicSource`
//! / `SystemSource`): the macOS and Windows signal readers live behind it so
//! the debounce/edge state machine in `monitor.rs` can be unit-tested against
//! a mock with zero native calls.
//!
//! A source's job is cheap and synchronous: one `poll()` returns a snapshot of
//! the two fused signals — is a known conferencing app running, and is the
//! microphone in use by some process. The source owns the registry match (it
//! has to enumerate processes/apps anyway), so it returns the already-matched
//! `MatchedApp` rather than a raw process list.

/// One conferencing app the registry recognises, resolved by a platform
/// source from a running process / app. Carries `&'static` data straight from
/// `apps::REGISTRY`, so it stays `Copy` and allocation-free until it's turned
/// into an owned event payload at emit time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MatchedApp {
    /// Stable id: bundle id on macOS, lowercased process basename on Windows.
    /// Used by the frontend to key snooze / "never for this app".
    pub id: &'static str,
    pub display_name: &'static str,
    /// True for browsers (Chrome/Safari/Arc/Edge). A browser being open is not
    /// itself a meeting; it only counts when the mic is also hot (the Google
    /// Meet heuristic). Surfaced to the UI so the copy can be softened.
    pub is_browser: bool,
}

/// One poll's worth of raw, un-debounced platform signals. The monitor's pure
/// state machine consumes these; it never calls the OS directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RawSignals {
    /// The matched conferencing app, if any known one is running. `None` when
    /// nothing recognised is up.
    pub conferencing_app: Option<MatchedApp>,
    /// True when the default input device is in use by *some* process.
    ///   * macOS  — `kAudioDevicePropertyDeviceIsRunningSomewhere`.
    ///   * Windows — any ConsentStore mic entry with `LastUsedTimeStop == 0`.
    pub mic_active: bool,
}

/// Errors a source can surface. Kept coarse on purpose — the monitor only
/// cares whether it got a usable reading; a failed poll is skipped, not fatal.
#[derive(Debug, thiserror::Error)]
pub enum DetectionError {
    #[error("platform error: {0}")]
    Platform(String),
}

/// Platform signal source. One `poll()` per tick, run on the monitor thread.
/// `Send` so the thread can own it; no `&mut self` because reads are stateless.
pub trait DetectionSource: Send {
    fn poll(&self) -> Result<RawSignals, DetectionError>;
}
