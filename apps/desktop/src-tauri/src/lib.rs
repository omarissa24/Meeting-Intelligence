mod audio;
mod auth;

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod recording;

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_shell::ShellExt;
use thiserror::Error;
use uuid::Uuid;

use crate::auth::{
    backend_url, exchange_code, fetch_logout_url, loopback as auth_loopback, parse_callback,
    refresh as refresh_tokens, storage as auth_storage, token_near_expiry, AuthError, OAuthState,
    SessionPayload, StoredSession,
};

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
    session_id: String,
) -> Result<StartRecordingResult, CommandError> {
    // Pre-check: refuse to double-start.
    {
        let guard = state
            .lock()
            .map_err(|e| CommandError::StatePoisoned(e.to_string()))?;
        if let Some(existing) = &guard.current_session_id {
            return Err(CommandError::AlreadyRecording(existing.clone()));
        }
    }

    // Validate the caller-supplied id is a UUID. The backend's
    // /transcript/ws handler casts it back to UUID and a malformed
    // string would surface as a confusing "session_id_not_uuid"
    // reject minutes after the user clicked Record. Catch it here.
    if Uuid::parse_str(&session_id).is_err() {
        return Err(CommandError::Audio(format!(
            "session_id is not a valid UUID: {session_id}"
        )));
    }
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

// --- Auth commands -------------------------------------------------------
//
// The desktop side of FR-2.01 / FR-2.02. Tokens persist in the OS
// credential store via `auth::storage`. The deep-link callback handler
// is wired up below in `run()` and emits `auth://session-changed` on
// success so the React side can flip from `<LoginView/>` to
// `<AppShell/>` without polling.

#[derive(Debug, Error)]
enum AuthCommandError {
    #[error("auth: {0}")]
    Auth(#[from] AuthError),
    #[error("shell: {0}")]
    Shell(String),
    #[error("state poisoned: {0}")]
    StatePoisoned(String),
}

impl serde::Serialize for AuthCommandError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDto {
    /// Raw WorkOS user JSON (id, email, …) — passed through verbatim
    /// so the UI can render whatever fields the SDK currently exposes
    /// without us re-modelling the dict.
    user: serde_json::Value,
}

/// Mint a CSRF nonce, stash it in `OAuthState`, and open the system
/// browser at the backend's `/auth/authorize` endpoint with the nonce
/// echoed in `state`. The deep-link handler validates the echo.
///
/// In debug builds, also bind the loopback HTTP server on
/// 127.0.0.1:53682 BEFORE opening the browser. AuthKit can be
/// configured via `WORKOS_REDIRECT_URI` to redirect to either:
///   - the deep-link scheme (production-bundled builds)
///   - http://localhost:53682/callback (`tauri:dev`)
/// Whichever path the redirect takes wins; the other one is dormant
/// for that login attempt. Bind happens before browser-open so a port
/// collision surfaces as an immediate UI error rather than a hung
/// sign-in.
#[tauri::command]
async fn auth_start_login<R: Runtime>(
    app: AppHandle<R>,
    oauth: State<'_, OAuthState>,
) -> Result<(), AuthCommandError> {
    // Use UUID v4 as the CSRF nonce — opaque, unguessable, and we
    // already pull `uuid` for session ids.
    let nonce = Uuid::new_v4().to_string();
    {
        let mut guard = oauth
            .pending_nonce
            .lock()
            .map_err(|e| AuthCommandError::StatePoisoned(e.to_string()))?;
        *guard = Some(nonce.clone());
    }

    // In debug builds, spin up the loopback listener so `tauri:dev`
    // can complete the OAuth round-trip (deep-link scheme can't route
    // back to non-bundled processes on macOS). Release builds skip
    // this — they rely on the deep-link plugin exclusively.
    #[cfg(debug_assertions)]
    {
        match auth_loopback::bind().await {
            Ok(listener) => {
                let app_for_loopback = app.clone();
                let oauth_for_loopback = oauth.inner().clone();
                tauri::async_runtime::spawn(async move {
                    auth_loopback::serve_once(app_for_loopback, oauth_for_loopback, listener)
                        .await;
                });
            }
            Err(err) => {
                // Clear the nonce since no listener is going to consume it.
                if let Ok(mut g) = oauth.pending_nonce.lock() {
                    *g = None;
                }
                return Err(AuthCommandError::Auth(err));
            }
        }
    }

    let base = backend_url().map_err(AuthCommandError::Auth)?;
    let url = format!("{base}/auth/authorize?state={}", nonce);
    // `Shell::open` is deprecated in favor of tauri-plugin-opener, but
    // pulling in another plugin for one URL is overkill — the call still
    // works and we can swap when we touch the shell elsewhere.
    #[allow(deprecated)]
    app.shell()
        .open(url, None)
        .map_err(|e| AuthCommandError::Shell(e.to_string()))?;
    Ok(())
}

/// Read the cached session from the OS credential store. Returns
/// `None` if the user isn't signed in (or if the cached refresh token
/// has been rejected during this call's pre-flight refresh attempt).
///
/// On hydrate (frontend mounting), this is what tells `auth-store`
/// whether to render `<LoginView/>` or jump straight to the shell.
#[tauri::command]
async fn auth_get_session() -> Result<Option<SessionDto>, AuthCommandError> {
    let stored = auth_storage::load()
        .map_err(|e| AuthCommandError::Auth(AuthError::Storage(e.to_string())))?;
    let Some(session) = stored else {
        return Ok(None);
    };
    let user: serde_json::Value =
        serde_json::from_str(&session.user_json).unwrap_or(serde_json::Value::Null);
    Ok(Some(SessionDto { user }))
}

/// Return the current access token, refreshing it transparently if it's
/// near expiry. Returns `None` if the user isn't signed in or the
/// refresh failed (in which case the cached session is wiped — the
/// frontend's 401 path handles surfacing this to the user).
#[tauri::command]
async fn auth_get_access_token() -> Result<Option<String>, AuthCommandError> {
    let stored = auth_storage::load()
        .map_err(|e| AuthCommandError::Auth(AuthError::Storage(e.to_string())))?;
    let Some(session) = stored else {
        return Ok(None);
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 60-second skew matches typical OAuth implementations and keeps
    // long WS handshakes from racing the expiry boundary.
    if !token_near_expiry(&session.access_token, now, 60) {
        return Ok(Some(session.access_token));
    }
    // Near expiry — try to refresh. If we don't have a refresh token,
    // we're stuck: clear and force re-login.
    let Some(rt) = session.refresh_token.as_ref() else {
        let _ = auth_storage::clear();
        return Ok(None);
    };
    match refresh_tokens(rt).await {
        Ok(refreshed) => {
            let user_json = serde_json::to_string(&refreshed.user)
                .unwrap_or_else(|_| "null".to_string());
            let new_stored = StoredSession {
                access_token: refreshed.access_token.clone(),
                refresh_token: refreshed.refresh_token.or(Some(rt.clone())),
                user_json,
            };
            auth_storage::save(&new_stored)
                .map_err(|e| AuthCommandError::Auth(AuthError::Storage(e.to_string())))?;
            Ok(Some(refreshed.access_token))
        }
        Err(_) => {
            // Refresh failed — wipe the cached session. The frontend
            // sees `null` from this command and bumps the user to
            // `<LoginView/>`.
            let _ = auth_storage::clear();
            Ok(None)
        }
    }
}

/// Clear the OS credential store and return the AuthKit logout URL the
/// frontend should open to end the AuthKit session. Errors from the
/// backend `/auth/logout` call are reported but don't block the local
/// clear — best-effort.
#[tauri::command]
async fn auth_logout() -> Result<String, AuthCommandError> {
    auth_storage::clear()
        .map_err(|e| AuthCommandError::Auth(AuthError::Storage(e.to_string())))?;
    // Fetch the AuthKit logout URL. If the backend is unreachable
    // we still want the local clear to count, so degrade to an empty
    // URL — the frontend treats that as "no browser hop needed".
    match fetch_logout_url().await {
        Ok(url) => Ok(url),
        Err(_) => Ok(String::new()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(RecordingState::default()))
        .manage(OAuthState::default())
        .setup(|app| {
            let app_handle = app.handle().clone();
            // Drain any deep link the OS handed us at launch (cold-start
            // case where the user clicked a meeting-intelligence:// link
            // that opened the app).
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for u in urls {
                    handle_deep_link(&app_handle, u.as_str());
                }
            }
            // Listen for deep links arriving while the app is running.
            let app_for_handler = app_handle.clone();
            app.deep_link().on_open_url(move |event| {
                for u in event.urls() {
                    handle_deep_link(&app_for_handler, u.as_str());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            check_audio_permissions,
            request_audio_permissions,
            auth_start_login,
            auth_get_session,
            auth_get_access_token,
            auth_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Meeting Intelligence");
}

/// Handle a single deep-link URL. Called both from the cold-start
/// drain and the on_open_url stream. Spawns the actual code-exchange
/// onto Tauri's async runtime so the deep-link callback returns
/// immediately — the OS doesn't like long-running handlers here.
fn handle_deep_link<R: Runtime>(app: &AppHandle<R>, url: &str) {
    let url = url.to_string();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = process_callback(&app, &url).await {
            // Surface to the frontend via a typed error event. The
            // login screen subscribes and shows the message in a toast
            // so the user can re-attempt.
            let _ = app.emit("auth://error", err.to_string());
        }
    });
}

/// Validate the CSRF nonce against the in-memory stash and consume it
/// on success. Pulled out so both the deep-link and loopback paths
/// share the same single-use semantics — a replayed callback URL
/// (whether arriving via `meeting-intelligence://` or
/// `localhost:1420/auth/callback`) is rejected with `StateMismatch`.
pub(crate) fn consume_pending_nonce(oauth: &OAuthState, state: &str) -> Result<(), AuthError> {
    let mut guard = oauth
        .pending_nonce
        .lock()
        .map_err(|e| AuthError::Storage(format!("oauth state: {e}")))?;
    match guard.as_ref() {
        Some(expected) if expected == state => {
            *guard = None;
            Ok(())
        }
        _ => Err(AuthError::StateMismatch),
    }
}

/// Run the WorkOS code exchange + persistence + session-changed emit.
/// Shared by the deep-link path (`process_callback`) and the
/// loopback-redirect Tauri command (`auth_complete_callback`).
///
/// Caller is responsible for having validated the CSRF nonce via
/// `consume_pending_nonce` first; this function trusts its inputs.
pub(crate) async fn complete_login<R: Runtime>(
    app: &AppHandle<R>,
    code: &str,
) -> Result<(), AuthError> {
    let tokens = exchange_code(code).await?;
    let user_json = serde_json::to_string(&tokens.user).unwrap_or_else(|_| "null".to_string());
    let stored = StoredSession {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user_json,
    };
    auth_storage::save(&stored).map_err(|e| AuthError::Storage(e.to_string()))?;
    let payload = SessionPayload {
        user: tokens.user,
    };
    let _ = app.emit("auth://session-changed", payload);
    Ok(())
}

async fn process_callback<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<(), AuthError> {
    let (code, state) = parse_callback(url)?;
    {
        let oauth: State<OAuthState> = app.state();
        consume_pending_nonce(&oauth, &state)?;
    }
    complete_login(app, &code).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consume_pending_nonce_accepts_match_then_rejects_replay() {
        let oauth = OAuthState::default();
        // Seed a pending nonce — same shape as `auth_start_login` does.
        *oauth.pending_nonce.lock().unwrap() = Some("nonce-abc".to_string());

        // First consume succeeds and clears the nonce.
        consume_pending_nonce(&oauth, "nonce-abc").expect("first consume should succeed");

        // Replay rejected — nonce is single-use. This is what
        // protects the loopback-redirect path from re-firing on a
        // hot-reload / browser back-button before the URL is stripped.
        let err = consume_pending_nonce(&oauth, "nonce-abc")
            .expect_err("replay should be rejected");
        assert!(matches!(err, AuthError::StateMismatch));
    }

    #[test]
    fn consume_pending_nonce_rejects_mismatched_state() {
        let oauth = OAuthState::default();
        *oauth.pending_nonce.lock().unwrap() = Some("expected".to_string());
        let err = consume_pending_nonce(&oauth, "attacker-supplied")
            .expect_err("mismatched state should be rejected");
        assert!(matches!(err, AuthError::StateMismatch));
        // The nonce is preserved on mismatch so a legitimate later
        // callback for the in-flight login still succeeds.
        assert_eq!(
            oauth.pending_nonce.lock().unwrap().as_deref(),
            Some("expected")
        );
    }

    #[test]
    fn consume_pending_nonce_rejects_when_no_login_pending() {
        let oauth = OAuthState::default();
        // No login was started — any incoming callback is suspect.
        let err = consume_pending_nonce(&oauth, "anything")
            .expect_err("no pending login should be rejected");
        assert!(matches!(err, AuthError::StateMismatch));
    }
}
