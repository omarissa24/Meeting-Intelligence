//! Tiny single-shot HTTP server that catches the OAuth callback when
//! the desktop is run via `tauri:dev`. Bound on `127.0.0.1:53682` —
//! the same port the GitHub CLI uses, picked to minimize collisions
//! with other dev-machine services.
//!
//! Why this exists at all: in production the WorkOS redirect goes to
//! `meeting-intelligence://auth/callback` and the deep-link plugin
//! routes the URL into the running app. In `tauri:dev` macOS
//! LaunchServices doesn't know about the dev binary (no bundle, no
//! Info.plist) so the URI scheme can't route. Instead we bind a
//! loopback listener before opening the browser, AuthKit redirects
//! the system browser to `http://127.0.0.1:53682/callback?...`, the
//! browser's GET hits this server directly (no React, no Tauri IPC),
//! and we run the same `complete_login` pipeline the deep-link
//! handler uses.
//!
//! Lifecycle: the listener lives only for one in-flight login. Bind
//! happens in `auth_start_login` BEFORE opening the browser so a port
//! collision surfaces as an immediate error rather than a hung sign-in.
//! After one request is handled — successful or not — the listener
//! drops and the port is free again.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::{AuthError, OAuthState};

pub const LOOPBACK_HOST: &str = "127.0.0.1";
pub const LOOPBACK_PORT: u16 = 53682;
/// Path the listener answers on. WorkOS dashboard must register this
/// exactly: `http://localhost:53682/callback`.
pub const LOOPBACK_PATH: &str = "/callback";
/// Total time we'll wait for the browser to redirect back. Five
/// minutes covers a lazy email/password sign-in and matches the
/// reconnect budget elsewhere in the app.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Per-request read timeout. Generous; a real browser sends the full
/// request line within milliseconds.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// We only ever read one HTTP request; cap the buffer so a malicious
/// peer pointing at the loopback port can't OOM us.
const MAX_REQUEST_BYTES: usize = 8 * 1024;

/// Try to bind the loopback listener. Returns `Ok(listener)` on
/// success; bind failures (port already in use, etc.) propagate as
/// `AuthError::Network` so the caller can surface them to the UI
/// without the browser ever opening.
pub async fn bind() -> Result<TcpListener, AuthError> {
    TcpListener::bind((LOOPBACK_HOST, LOOPBACK_PORT))
        .await
        .map_err(|e| {
            AuthError::Network(format!(
                "could not bind loopback {LOOPBACK_HOST}:{LOOPBACK_PORT}: {e}. \
                 Another process may already be using this port — close it and retry."
            ))
        })
}

/// Drive a bound listener through one full callback cycle: accept one
/// connection, parse the request, run the WorkOS exchange, write a
/// human-readable response, drop. Errors are emitted to the frontend
/// as `auth://error` events; the listener is consumed either way.
///
/// The whole thing is wrapped in a 5-minute timeout so a forgotten
/// browser tab can't pin the port forever.
pub async fn serve_once<R: Runtime>(
    app: AppHandle<R>,
    oauth: OAuthState,
    listener: TcpListener,
) {
    let outcome = tokio::time::timeout(LOGIN_TIMEOUT, accept_and_handle(&app, &oauth, listener))
        .await;

    match outcome {
        Ok(Ok(())) => {} // success path emits session-changed inside complete_login
        Ok(Err(err)) => {
            let _ = app.emit("auth://error", err.to_string());
        }
        Err(_elapsed) => {
            // Timeout — drop the in-flight nonce so a stale callback
            // can't sneak in later, and tell the UI.
            if let Ok(mut g) = oauth.pending_nonce.lock() {
                *g = None;
            }
            let _ = app.emit(
                "auth://error",
                "Sign-in timed out. The browser didn't redirect back within 5 minutes.",
            );
        }
    }
}

async fn accept_and_handle<R: Runtime>(
    app: &AppHandle<R>,
    oauth: &OAuthState,
    listener: TcpListener,
) -> Result<(), AuthError> {
    let (mut sock, _peer) = listener
        .accept()
        .await
        .map_err(|e| AuthError::Network(format!("loopback accept: {e}")))?;

    // Read the request line + just enough headers to find the path.
    // We don't care about Host, Cookies, etc. — this is a one-shot
    // server only the local browser hits.
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let read_deadline = tokio::time::Instant::now() + READ_TIMEOUT;
    loop {
        if buf.len() >= MAX_REQUEST_BYTES {
            return Err(AuthError::BadCallback(
                "request too large; refusing to read further".into(),
            ));
        }
        let now = tokio::time::Instant::now();
        if now >= read_deadline {
            return Err(AuthError::Network("read timeout on loopback".into()));
        }
        let remaining = read_deadline - now;
        let n_or = tokio::time::timeout(remaining, sock.read(&mut chunk)).await;
        let n = match n_or {
            Ok(Ok(0)) => break, // peer closed
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(AuthError::Network(format!("loopback read: {e}"))),
            Err(_) => return Err(AuthError::Network("read timeout on loopback".into())),
        };
        buf.extend_from_slice(&chunk[..n]);
        // We have enough as soon as we see the end of the request
        // line — we don't need the body. Browsers send the full
        // request line in the first packet.
        if buf.windows(2).any(|w| w == b"\r\n") {
            break;
        }
    }

    let result = parse_and_dispatch(app, oauth, &buf).await;
    let (status, body) = match &result {
        Ok(()) => ("200 OK", SUCCESS_HTML),
        Err(AuthError::StateMismatch) => ("400 Bad Request", FAILURE_HTML_STATE),
        Err(AuthError::BadCallback(_)) => ("400 Bad Request", FAILURE_HTML_BAD_REQUEST),
        Err(_) => ("500 Internal Server Error", FAILURE_HTML_GENERIC),
    };
    let response = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         Cache-Control: no-store\r\n\
         \r\n{body}",
        body.len()
    );
    // Best-effort write; if the browser closed the connection
    // already, we still want the result to land in our return value.
    let _ = sock.write_all(response.as_bytes()).await;
    let _ = sock.shutdown().await;

    result
}

async fn parse_and_dispatch<R: Runtime>(
    app: &AppHandle<R>,
    oauth: &OAuthState,
    request_bytes: &[u8],
) -> Result<(), AuthError> {
    // Request line: `GET /callback?code=...&state=... HTTP/1.1`. We
    // accept any path since the browser may follow a redirect that
    // appended trailing slashes; the query is what matters.
    let head = std::str::from_utf8(request_bytes)
        .map_err(|_| AuthError::BadCallback("non-UTF-8 request".into()))?;
    let line = head
        .lines()
        .next()
        .ok_or_else(|| AuthError::BadCallback("empty request".into()))?;
    let mut parts = line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| AuthError::BadCallback("missing method".into()))?;
    let target = parts
        .next()
        .ok_or_else(|| AuthError::BadCallback("missing target".into()))?;
    if method != "GET" {
        return Err(AuthError::BadCallback(format!(
            "unsupported method {method}"
        )));
    }

    // Reject anything that isn't `/callback...` — favicon probes etc
    // shouldn't burn the in-flight nonce.
    let path_only = target.split('?').next().unwrap_or("");
    if path_only != LOOPBACK_PATH {
        return Err(AuthError::BadCallback(format!(
            "unexpected path {path_only}; expected {LOOPBACK_PATH}"
        )));
    }

    let (code, state) = parse_query(target)?;
    super::super::consume_pending_nonce(oauth, &state)?;
    super::super::complete_login(app, &code).await
}

/// Pull `code` and `state` out of the request target's query string.
/// Doesn't try to be a full URL parser — only handles
/// percent-decoding for `+` (rare but seen) and `%` escapes; AuthKit
/// emits codes that need no decoding in practice but we cover the
/// case so a future provider doesn't trip us.
fn parse_query(target: &str) -> Result<(String, String), AuthError> {
    let q = target
        .split_once('?')
        .map(|(_, q)| q)
        .ok_or_else(|| AuthError::BadCallback("missing query".into()))?;
    let mut code = None;
    let mut state = None;
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = percent_decode(v);
        match k {
            "code" => code = Some(v),
            "state" => state = Some(v),
            _ => {}
        }
    }
    let code = code.ok_or_else(|| AuthError::BadCallback("missing code".into()))?;
    let state = state.ok_or_else(|| AuthError::BadCallback("missing state".into()))?;
    Ok((code, state))
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push(((hi * 16 + lo) as u8) as char);
                    i += 3;
                } else {
                    out.push(bytes[i] as char);
                    i += 1;
                }
            }
            b => {
                out.push(b as char);
                i += 1;
            }
        }
    }
    out
}

const SUCCESS_HTML: &str = r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Signed in</title>
<style>
  html,body{height:100%}
  body{margin:0;display:grid;place-items:center;background:#f6f3ec;color:#1f2533;font:400 16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .card{padding:48px 56px;text-align:center;max-width:24rem}
  h1{margin:0 0 12px;font:400 28px/1.2 "Instrument Serif",Georgia,serif;letter-spacing:-0.01em}
  p{margin:0;color:#5b6171}
</style></head>
<body><div class="card">
  <h1>Signed in</h1>
  <p>You can close this tab and return to Meeting Intelligence.</p>
</div></body></html>"#;

const FAILURE_HTML_STATE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Sign-in error</title></head><body style="font:16px/1.5 -apple-system,sans-serif;padding:2rem"><h1 style="font:400 24px Georgia,serif">Sign-in could not be verified</h1><p>The state parameter didn't match. This usually means the link is stale or was opened in a different window. Please return to Meeting Intelligence and try again.</p></body></html>"#;

const FAILURE_HTML_BAD_REQUEST: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Sign-in error</title></head><body style="font:16px/1.5 -apple-system,sans-serif;padding:2rem"><h1 style="font:400 24px Georgia,serif">Sign-in could not be completed</h1><p>The callback URL was malformed. Please return to Meeting Intelligence and try again.</p></body></html>"#;

const FAILURE_HTML_GENERIC: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Sign-in error</title></head><body style="font:16px/1.5 -apple-system,sans-serif;padding:2rem"><h1 style="font:400 24px Georgia,serif">Sign-in failed</h1><p>Something went wrong while completing the sign-in. Please return to Meeting Intelligence and try again — the app will surface the underlying error.</p></body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_query_extracts_code_and_state() {
        let (code, state) = parse_query("/callback?code=abc&state=xyz").unwrap();
        assert_eq!(code, "abc");
        assert_eq!(state, "xyz");
    }

    #[test]
    fn parse_query_handles_extra_params() {
        let (code, state) =
            parse_query("/callback?code=abc&state=xyz&trace=workos&foo=bar").unwrap();
        assert_eq!(code, "abc");
        assert_eq!(state, "xyz");
    }

    #[test]
    fn parse_query_percent_decodes_value() {
        // WorkOS doesn't emit percent-encoded codes today but the
        // OAuth spec allows it; cover it so a provider change can't
        // silently break us.
        let (code, state) = parse_query("/callback?code=a%2Fb&state=x%20y").unwrap();
        assert_eq!(code, "a/b");
        assert_eq!(state, "x y");
    }

    #[test]
    fn parse_query_rejects_missing_code() {
        let err = parse_query("/callback?state=xyz").unwrap_err();
        assert!(matches!(err, AuthError::BadCallback(_)));
    }

    #[test]
    fn parse_query_rejects_missing_state() {
        let err = parse_query("/callback?code=abc").unwrap_err();
        assert!(matches!(err, AuthError::BadCallback(_)));
    }

    #[test]
    fn percent_decode_basic() {
        assert_eq!(percent_decode("abc"), "abc");
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("incomplete%2"), "incomplete%2");
    }
}
