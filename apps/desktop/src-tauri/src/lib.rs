mod audio;

#[cfg(target_os = "macos")]
mod recording;

use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use thiserror::Error;
use uuid::Uuid;

#[cfg(target_os = "macos")]
use crate::audio::macos::permissions::{self, PermissionsSnapshot};
#[cfg(target_os = "macos")]
use crate::recording::{Session, SessionStats};

#[derive(Default)]
struct RecordingState {
    current_session_id: Option<String>,
    started_at: Option<DateTime<Utc>>,
    /// The live recording session — owns the audio capture sources,
    /// pipeline, and emitter thread. `None` when idle. Only present
    /// on macOS for now; Windows lands behind the same trait surface
    /// in a later slice.
    #[cfg(target_os = "macos")]
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
    #[cfg(target_os = "macos")]
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

    #[cfg(target_os = "macos")]
    let session = Session::start(&app, session_id.clone())
        .map_err(|e| CommandError::Audio(e.to_string()))?;

    #[cfg(not(target_os = "macos"))]
    {
        // Keep `app` referenced so the unused-variable lint stays
        // quiet when we cross-compile for Linux CI.
        let _ = app;
        return Err(CommandError::UnsupportedPlatform);
    }

    #[cfg(target_os = "macos")]
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
        #[cfg(target_os = "macos")]
        let session = guard.session.take();
        #[cfg(not(target_os = "macos"))]
        let session: Option<()> = None;
        (session_id, started_at, session)
    };

    #[cfg(target_os = "macos")]
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
        #[cfg(target_os = "macos")]
        stats,
    })
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn check_audio_permissions() -> Result<PermissionsSnapshot, CommandError> {
    // Cheap synchronous reads — no need for spawn_blocking.
    permissions::check_all().map_err(|e| CommandError::Permissions(e.to_string()))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn check_audio_permissions() -> Result<(), CommandError> {
    Err(CommandError::UnsupportedPlatform)
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn request_audio_permissions() -> Result<PermissionsSnapshot, CommandError> {
    // request_all blocks the calling thread on the AV completion
    // handler and the SC poll loop, so route it through
    // spawn_blocking to keep the IPC reactor unblocked.
    tauri::async_runtime::spawn_blocking(permissions::request_all)
        .await
        .map_err(|e| CommandError::Permissions(format!("join: {e}")))?
        .map_err(|e| CommandError::Permissions(e.to_string()))
}

#[cfg(not(target_os = "macos"))]
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
