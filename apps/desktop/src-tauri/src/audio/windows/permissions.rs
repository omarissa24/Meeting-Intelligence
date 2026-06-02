//! Windows permission surface.
//!
//! Windows has no in-process API to prompt the user for mic access —
//! the OS surfaces a permission toggle in Settings → Privacy →
//! Microphone, and `cpal::Device::build_input_stream` simply errors out
//! if the toggle is off. WASAPI loopback for system audio never
//! prompts at all (it captures whatever the user is hearing).
//!
//! We expose the same `check_all` / `request_all` / `PermissionsSnapshot`
//! shape as the macOS module so the Tauri command handlers in `lib.rs`
//! and the frontend wire up uniformly. Both functions return
//! `PermState::Granted` unconditionally — runtime errors from a blocked
//! mic toggle surface later as `SourceError::Platform` from the cpal
//! source, which is good enough for MVP.

use serde::Serialize;

/// Snapshot of one privacy gate's state. Mirror of macOS's `PermState`
/// so the IPC payload shape is identical across platforms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermState {
    Granted,
    Denied,
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
    #[error("{0}")]
    Internal(String),
}

pub fn check_all() -> Result<PermissionsSnapshot, PermissionError> {
    Ok(PermissionsSnapshot {
        mic: PermState::Granted,
        screen: PermState::Granted,
    })
}

pub fn request_all() -> Result<PermissionsSnapshot, PermissionError> {
    check_all()
}
