use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::State;
use thiserror::Error;
use uuid::Uuid;

#[derive(Default)]
struct RecordingState {
    current_session_id: Option<String>,
    started_at: Option<DateTime<Utc>>,
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
}

#[derive(Debug, Error)]
enum CommandError {
    #[error("already recording (session {0})")]
    AlreadyRecording(String),
    #[error("no active recording")]
    NotRecording,
    #[error("recording state poisoned: {0}")]
    StatePoisoned(String),
}

// Errors cross the IPC boundary as plain strings — keeps the frontend's
// `invoke()` rejection shape consistent regardless of the variant.
impl serde::Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[tauri::command]
async fn start_recording(
    state: State<'_, Mutex<RecordingState>>,
) -> Result<StartRecordingResult, CommandError> {
    let mut guard = state
        .lock()
        .map_err(|e| CommandError::StatePoisoned(e.to_string()))?;

    if let Some(existing) = &guard.current_session_id {
        return Err(CommandError::AlreadyRecording(existing.clone()));
    }

    let session_id = Uuid::new_v4().to_string();
    let started_at = Utc::now();
    guard.current_session_id = Some(session_id.clone());
    guard.started_at = Some(started_at);

    Ok(StartRecordingResult {
        session_id,
        started_at: started_at.to_rfc3339(),
    })
}

#[tauri::command]
async fn stop_recording(
    state: State<'_, Mutex<RecordingState>>,
) -> Result<StopRecordingResult, CommandError> {
    let mut guard = state
        .lock()
        .map_err(|e| CommandError::StatePoisoned(e.to_string()))?;

    let session_id = guard
        .current_session_id
        .take()
        .ok_or(CommandError::NotRecording)?;
    let started_at = guard.started_at.take().ok_or(CommandError::NotRecording)?;
    let ended_at = Utc::now();
    let duration_ms = (ended_at - started_at)
        .num_milliseconds()
        .max(0)
        .unsigned_abs();

    Ok(StopRecordingResult {
        session_id,
        ended_at: ended_at.to_rfc3339(),
        duration_ms,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(RecordingState::default()))
        .invoke_handler(tauri::generate_handler![start_recording, stop_recording])
        .run(tauri::generate_context!())
        .expect("error while running Meeting Intelligence");
}
