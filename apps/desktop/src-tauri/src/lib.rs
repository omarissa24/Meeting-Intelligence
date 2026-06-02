mod audio;

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod recording;

use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use thiserror::Error;
use uuid::Uuid;

#[cfg(target_os = "macos")]
use crate::audio::macos::permissions::{self, PermissionsSnapshot};
#[cfg(target_os = "windows")]
use crate::audio::windows::permissions::{self, PermissionsSnapshot};

#[cfg(any(target_os = "macos", target_os = "windows"))]
use crate::recording::{Session, SessionStats};

#[derive(Default)]
struct RecordingState {
    current_session_id: Option<String>,
    started_at: Option<DateTime<Utc>>,
    /// The live recording session — owns the audio capture sources,
    /// pipeline, and emitter thread. `None` when idle. Present on
    /// macOS (ScreenCaptureKit) and Windows (WASAPI loopback); absent
    /// on Linux until a Linux source lands.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    session: Option<Session>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartRecordingResult {
    session_id: String,
    started_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StopRecordingResult {
    session_id: String,
    ended_at: String,
    duration_ms: u64,
    /// Capture-side stats. `None` on platforms where native audio
    /// capture isn't wired up yet.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    stats: Option<SessionStats>,
}

#[derive(Debug, Error)]
enum CommandError {
    #[error("already recording (session {0})")]
    AlreadyRecording(String),
    #[error("no active recording")]
    NotRecording,
    #[error("recording state poisoned: {0}")]
    StatePoisoned(String),
    #[error("audio capture: {0}")]
    Audio(String),
    #[error("permissions: {0}")]
    Permissions(String),
    /// Constructed only on non-macOS targets; we keep it on macOS too
    /// so the error type stays uniform across platforms.
    #[allow(dead_code)]
    #[error("native audio capture is not implemented on this platform yet")]
    UnsupportedPlatform,
}

// Errors cross the IPC boundary as plain strings — keeps the frontend's
// `invoke()` rejection shape consistent regardless of the variant.
impl serde::Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[tauri::command]
async fn start_recording<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Mutex<RecordingState>>,
) -> Result<StartRecordingResult, CommandError> {
    // Pre-check: refuse to double-start. Generate the session id
    // outside the lock so we don't allocate while holding it.
    {
        let guard = state
            .lock()
            .map_err(|e| CommandError::StatePoisoned(e.to_string()))?;
        if let Some(existing) = &guard.current_session_id {
            return Err(CommandError::AlreadyRecording(existing.clone()));
        }
    }

    let session_id = Uuid::new_v4().to_string();
    let started_at = Utc::now();

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let session = Session::start(&app, session_id.clone())
        .map_err(|e| CommandError::Audio(e.to_string()))?;

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Keep `app` referenced so the unused-variable lint stays
        // quiet when we cross-compile for Linux CI.
        let _ = app;
        return Err(CommandError::UnsupportedPlatform);
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let mut guard = state
            .lock()
            .map_err(|e| CommandError::StatePoisoned(e.to_string()))?;
        // Re-check under the lock in case another start_recording
        // raced past the pre-check. If so, tear down the new session.
        if let Some(existing) = &guard.current_session_id {
            let existing = existing.clone();
            drop(guard);
            let _ = session.stop();
            return Err(CommandError::AlreadyRecording(existing));
        }
        guard.current_session_id = Some(session_id.clone());
        guard.started_at = Some(started_at);
        guard.session = Some(session);
    }

    Ok(StartRecordingResult {
        session_id,
        started_at: started_at.to_rfc3339(),
    })
}

#[tauri::command]
async fn stop_recording(
    state: State<'_, Mutex<RecordingState>>,
) -> Result<StopRecordingResult, CommandError> {
    // Take the session out of the lock first; stopping it can take
    // up to ~700 ms (drain + join), and we don't want to hold the
    // mutex across that.
    let (session_id, started_at, _session_opt) = {
        let mut guard = state
            .lock()
            .map_err(|e| CommandError::StatePoisoned(e.to_string()))?;
        let session_id = guard
            .current_session_id
            .take()
            .ok_or(CommandError::NotRecording)?;
        let started_at = guard.started_at.take().ok_or(CommandError::NotRecording)?;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let session = guard.session.take();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let session: Option<()> = None;
        (session_id, started_at, session)
    };

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let stats = _session_opt.map(|s| s.stop());

    let ended_at = Utc::now();
    let duration_ms = (ended_at - started_at)
        .num_milliseconds()
        .max(0)
        .unsigned_abs();

    Ok(StopRecordingResult {
        session_id,
        ended_at: ended_at.to_rfc3339(),
        duration_ms,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        stats,
    })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
async fn check_audio_permissions() -> Result<PermissionsSnapshot, CommandError> {
    // Cheap synchronous reads — no need for spawn_blocking. (Windows
    // returns Granted unconditionally; macOS hits AVCaptureDevice +
    // SCShareableContent.)
    permissions::check_all().map_err(|e| CommandError::Permissions(e.to_string()))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
async fn check_audio_permissions() -> Result<(), CommandError> {
    Err(CommandError::UnsupportedPlatform)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[tauri::command]
async fn request_audio_permissions() -> Result<PermissionsSnapshot, CommandError> {
    // On macOS, request_all blocks the calling thread on the AV
    // completion handler and the SC poll loop, so route through
    // spawn_blocking to keep the IPC reactor unblocked. On Windows
    // it's a no-op but going through spawn_blocking keeps the call
    // shape uniform.
    tauri::async_runtime::spawn_blocking(permissions::request_all)
        .await
        .map_err(|e| CommandError::Permissions(format!("join: {e}")))?
        .map_err(|e| CommandError::Permissions(e.to_string()))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
async fn request_audio_permissions() -> Result<(), CommandError> {
    Err(CommandError::UnsupportedPlatform)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(RecordingState::default()))
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            check_audio_permissions,
            request_audio_permissions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Meeting Intelligence");
}
