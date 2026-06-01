//! macOS permission probes for the two privacy gates this app touches:
//!   * **Microphone** — checked + requested via `AVCaptureDevice`.
//!   * **Screen Recording** (which is also what gates ScreenCaptureKit's
//!     audio capture) — there is no public-API request handler for
//!     this; the *first* call to `SCShareableContent::get()` triggers
//!     the macOS prompt, and a successful return implies "granted".
//!     We implement the screen check by attempting that call and
//!     mapping success/failure to a `PermState`.
//!
//! `request_mic` blocks the calling thread until the user dismisses the
//! prompt — the AVCaptureDevice handler is async and runs on an
//! arbitrary dispatch queue, so we use a parking primitive to bridge
//! back into sync land. The Tauri command wraps this in
//! `tauri::async_runtime::spawn_blocking` so the IPC thread doesn't
//! stall.
//!
//! See plan risk #3: the SC daemon takes time after a first-time grant
//! before subsequent capture starts work. `request_screen` polls
//! `SCShareableContent::get()` until it succeeds (or a timeout) so the
//! "≤2 s after grant" target stays achievable.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use screencapturekit::shareable_content::SCShareableContent;
use serde::Serialize;

/// Snapshot of one privacy gate's state. Mirror of macOS's
/// `AVAuthorizationStatus`, simplified to the three states the UI
/// actually distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermState {
    /// User has granted access (or this app is allow-listed).
    Granted,
    /// User has explicitly denied or the system has restricted access.
    /// We can't recover from this in-process — show a "Open System
    /// Settings" CTA instead.
    Denied,
    /// The user has never been asked. A `request_*` call will trigger
    /// the system prompt.
    NotDetermined,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsSnapshot {
    pub mic: PermState,
    pub screen: PermState,
}

#[derive(Debug, thiserror::Error)]
pub enum PermissionError {
    #[error("AVMediaTypeAudio constant missing — AVFoundation not linked?")]
    MissingMediaTypeAudio,
    #[error("permission request timed out")]
    Timeout,
    #[error("{0}")]
    Internal(String),
}

/// Read the current authorization status without prompting. Returns
/// `NotDetermined` if the user has never been asked.
pub fn check_mic() -> Result<PermState, PermissionError> {
    let media_type =
        unsafe { AVMediaTypeAudio.as_deref() }.ok_or(PermissionError::MissingMediaTypeAudio)?;
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    Ok(av_status_to_perm(status))
}

/// Trigger the macOS mic prompt if the user has never been asked, then
/// return the resulting state. If the status is already determined,
/// returns immediately without prompting.
pub fn request_mic() -> Result<PermState, PermissionError> {
    let current = check_mic()?;
    if current != PermState::NotDetermined {
        return Ok(current);
    }

    let media_type =
        unsafe { AVMediaTypeAudio.as_deref() }.ok_or(PermissionError::MissingMediaTypeAudio)?;

    // Park the calling thread on a Condvar; the AV handler wakes it
    // with the boolean result. The handler runs on an arbitrary
    // dispatch queue — Apple's docs explicitly call this out.
    let pair: Arc<(Mutex<Option<bool>>, Condvar)> = Arc::new((Mutex::new(None), Condvar::new()));
    let pair_for_block = pair.clone();
    let handler = RcBlock::new(move |granted: Bool| {
        let (lock, cvar) = &*pair_for_block;
        let mut slot = lock.lock().expect("permissions condvar poisoned");
        *slot = Some(granted.as_bool());
        cvar.notify_all();
    });

    unsafe {
        AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &handler);
    }

    // Wait up to 60 s for the user to interact with the prompt.
    // `Condvar::wait_timeout` requires we re-check the predicate
    // because of spurious wakeups.
    let (lock, cvar) = &*pair;
    let mut guard = lock.lock().expect("permissions condvar poisoned");
    let deadline = Instant::now() + Duration::from_secs(60);
    while guard.is_none() {
        let now = Instant::now();
        if now >= deadline {
            return Err(PermissionError::Timeout);
        }
        let (g, _) = cvar
            .wait_timeout(guard, deadline - now)
            .map_err(|e| PermissionError::Internal(format!("condvar: {e}")))?;
        guard = g;
    }

    let granted = guard.expect("predicate already verified");
    Ok(if granted {
        PermState::Granted
    } else {
        PermState::Denied
    })
}

/// Probe screen-recording permission via SCShareableContent. There is
/// no separate "status without prompting" API — the call itself
/// triggers the system prompt the first time. Subsequent failures
/// distinguish denied (call returns Err) from granted (call returns
/// Ok).
///
/// We can't reliably distinguish "never asked" from "denied" with the
/// public SC API, so we collapse both into `Denied` until the call
/// succeeds at least once. Callers should pair this with a UI prompt
/// on first launch that explains the System Settings → Screen
/// Recording flow.
pub fn check_screen() -> PermState {
    match SCShareableContent::get() {
        Ok(_) => PermState::Granted,
        Err(_) => PermState::Denied,
    }
}

/// Trigger the screen-recording prompt and poll until it succeeds (or
/// the timeout elapses). Useful when the user has just granted access
/// in System Settings and we need to know when the SC daemon has
/// observed it. Plan risk #3.
pub fn request_screen() -> PermState {
    // First call triggers the prompt or returns success/denied.
    if let Ok(_) = SCShareableContent::get() {
        return PermState::Granted;
    }

    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        if SCShareableContent::get().is_ok() {
            return PermState::Granted;
        }
    }
    PermState::Denied
}

/// Snapshot both gates without triggering prompts. Used by the
/// `check_audio_permissions` Tauri command on app start.
pub fn check_all() -> Result<PermissionsSnapshot, PermissionError> {
    Ok(PermissionsSnapshot {
        mic: check_mic()?,
        screen: check_screen(),
    })
}

/// Trigger both prompts in sequence: mic first, then screen. Returns
/// the resulting state. The Tauri command wraps this in
/// `spawn_blocking` because both calls block.
pub fn request_all() -> Result<PermissionsSnapshot, PermissionError> {
    let mic = request_mic()?;
    let screen = request_screen();
    Ok(PermissionsSnapshot { mic, screen })
}

fn av_status_to_perm(s: AVAuthorizationStatus) -> PermState {
    match s {
        AVAuthorizationStatus::Authorized => PermState::Granted,
        AVAuthorizationStatus::Denied | AVAuthorizationStatus::Restricted => PermState::Denied,
        AVAuthorizationStatus::NotDetermined => PermState::NotDetermined,
        // AVAuthorizationStatus is a tuple-newtype around NSInteger,
        // so future macOS versions could add variants. Treat any
        // unknown value as Denied to avoid silently auto-granting.
        _ => PermState::Denied,
    }
}
