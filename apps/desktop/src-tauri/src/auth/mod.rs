//! Phase-2 desktop auth glue.
//!
//! End-to-end:
//!   1. Frontend calls `auth_start_login` → we mint a CSRF nonce, stash
//!      it in `OAuthState`, and open the system browser at
//!      `BACKEND/auth/authorize?state=<nonce>`.
//!   2. AuthKit redirects the OS to
//!      `meeting-intelligence://auth/callback?code=...&state=...`.
//!   3. The deep-link plugin's `on_open_url` handler (registered in
//!      `lib.rs::run`) parses the URL, validates `state` against our
//!      stash, POSTs `code` to `BACKEND/auth/callback`, persists the
//!      returned tokens via `storage::save`, and emits
//!      `auth://session-changed` so the frontend swaps `<LoginView/>`
//!      for `<AppShell/>`.
//!
//! Token storage: OS credential store (Keychain / Credential Manager)
//! via `keyring`. See `storage.rs`. FR-2.02.

pub mod loopback;
pub mod storage;

use std::sync::Mutex;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

pub use storage::StoredSession;

/// In-memory CSRF nonce stash. The frontend triggers a login by calling
/// `auth_start_login`, which mints a nonce and writes it here. The
/// deep-link callback handler validates the nonce echoed back in
/// `state` against this value before exchanging the code.
///
/// Uses `Arc<Mutex<...>>` internally so the loopback HTTP server task
/// (`loopback::serve_once`) can take a cloned handle and read/write
/// the same nonce as the deep-link path. Both paths are mutually
/// exclusive in production deployments — only one redirect URI is
/// configured at a time — but both are always wired so a misconfigured
/// dashboard fails loudly rather than silently.
#[derive(Default, Clone)]
pub struct OAuthState {
    pub pending_nonce: std::sync::Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Error)]
pub enum AuthError {
    /// Reserved for the case where we require a build-time
    /// `BACKEND_URL` (currently we fall back to localhost).
    #[allow(dead_code)]
    #[error("backend URL is not configured")]
    BackendNotConfigured,
    #[error("storage: {0}")]
    Storage(String),
    #[error("network: {0}")]
    Network(String),
    #[error("backend rejected request: {status} {body}")]
    BackendStatus { status: u16, body: String },
    #[error("decode: {0}")]
    Decode(String),
    #[error("callback URL is malformed: {0}")]
    BadCallback(String),
    #[error("state mismatch — possible CSRF; aborting login")]
    StateMismatch,
}

impl serde::Serialize for AuthError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<keyring::Error> for AuthError {
    fn from(e: keyring::Error) -> Self {
        AuthError::Storage(e.to_string())
    }
}

impl From<reqwest::Error> for AuthError {
    fn from(e: reqwest::Error) -> Self {
        AuthError::Network(e.to_string())
    }
}

/// What `/auth/callback` and `/auth/refresh` return. Mirrors
/// `TokenResponse` in `backend/src/meeting_intelligence/api/auth.py`.
/// `user` is left as a free-form JSON value because the WorkOS dict
/// shape varies with SDK version and we don't need to model every field
/// on the desktop side.
#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    #[serde(rename = "accessToken")]
    pub access_token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: Option<String>,
    pub user: serde_json::Value,
}

/// What we hand back to the frontend in `auth://session-changed`.
#[derive(Debug, Serialize, Clone)]
pub struct SessionPayload {
    pub user: serde_json::Value,
}

/// Resolve the backend HTTP base URL. Compile-time `BACKEND_URL` env
/// wins; otherwise fall back to localhost so `tauri:dev` works
/// out-of-the-box. The frontend uses `VITE_BACKEND_URL` for the same
/// purpose — keep them aligned in deploy configs.
pub fn backend_url() -> Result<String, AuthError> {
    if let Some(v) = option_env!("BACKEND_URL") {
        if !v.trim().is_empty() {
            return Ok(v.trim().trim_end_matches('/').to_string());
        }
    }
    // Sensible localhost default. If the user runs the backend on a
    // different host they should set BACKEND_URL at build time.
    Ok("http://localhost:8000".to_string())
}

/// POST `code` to `/auth/callback` and return the issued tokens.
pub async fn exchange_code(code: &str) -> Result<TokenResponse, AuthError> {
    let base = backend_url()?;
    let url = format!("{base}/auth/callback?code={}", urlencoding(code));
    let client = reqwest::Client::builder()
        .build()
        .map_err(AuthError::from)?;
    let resp = client.get(&url).send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AuthError::BackendStatus {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: TokenResponse = resp.json().await?;
    Ok(parsed)
}

/// POST a refresh token to `/auth/refresh` and return the rotated
/// tokens. Caller is responsible for persisting the result and wiping
/// the cached session on Err.
pub async fn refresh(refresh_token: &str) -> Result<TokenResponse, AuthError> {
    let base = backend_url()?;
    let url = format!("{base}/auth/refresh");
    let client = reqwest::Client::builder()
        .build()
        .map_err(AuthError::from)?;
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AuthError::BackendStatus {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: TokenResponse = resp.json().await?;
    Ok(parsed)
}

/// Hit `/auth/logout` to get the AuthKit logout URL. The desktop opens
/// it in the system browser to end the AuthKit session — WorkOS
/// doesn't revoke tokens server-side from this call.
pub async fn fetch_logout_url() -> Result<String, AuthError> {
    let base = backend_url()?;
    let url = format!("{base}/auth/logout");
    let client = reqwest::Client::builder()
        .build()
        .map_err(AuthError::from)?;
    let resp = client.post(&url).json(&serde_json::json!({})).send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AuthError::BackendStatus {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: serde_json::Value = resp.json().await?;
    parsed
        .get("logoutUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AuthError::Decode("missing logoutUrl in /auth/logout response".into()))
}

/// Parse the deep-link callback URL we registered for. Returns
/// `(code, state)`; rejects URLs missing either field.
pub fn parse_callback(url_str: &str) -> Result<(String, String), AuthError> {
    let parsed = Url::parse(url_str).map_err(|e| AuthError::BadCallback(e.to_string()))?;
    if parsed.scheme() != "meeting-intelligence" {
        return Err(AuthError::BadCallback(format!(
            "expected meeting-intelligence scheme, got {}",
            parsed.scheme()
        )));
    }
    let mut code = None;
    let mut state = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.to_string()),
            "state" => state = Some(v.to_string()),
            _ => {}
        }
    }
    let code = code.ok_or_else(|| AuthError::BadCallback("missing code".into()))?;
    let state = state.ok_or_else(|| AuthError::BadCallback("missing state".into()))?;
    Ok((code, state))
}

/// Decode the `exp` claim of a JWT without verifying the signature.
/// Used only to decide whether to proactively refresh — the backend
/// still verifies the signature on every request, so a malformed `exp`
/// just means we may attempt a doomed refresh, which is fine.
///
/// Returns `None` if the token isn't a recognizable three-segment JWT
/// or doesn't carry an `exp` integer.
pub fn jwt_exp_seconds(token: &str) -> Option<u64> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _sig = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("exp").and_then(|v| v.as_u64())
}

/// True if the token's `exp` is in the past (or within `skew_secs`).
/// Tokens we can't parse are treated as not-near-expiry — let them
/// reach the backend, which will reject them and force a re-login.
pub fn token_near_expiry(token: &str, now_secs: u64, skew_secs: u64) -> bool {
    match jwt_exp_seconds(token) {
        Some(exp) => exp <= now_secs.saturating_add(skew_secs),
        None => false,
    }
}

/// Minimal percent-encoder for the small set of characters that can
/// appear in WorkOS auth codes. Falls back to passing the input
/// through unchanged for anything alphanumeric/dash/underscore — which
/// covers the WorkOS code shape — and percent-escapes the rest.
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_callback_extracts_code_and_state() {
        let url = "meeting-intelligence://auth/callback?code=abc123&state=xyz789";
        let (code, state) = parse_callback(url).unwrap();
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz789");
    }

    #[test]
    fn parse_callback_rejects_missing_code() {
        let url = "meeting-intelligence://auth/callback?state=xyz789";
        let err = parse_callback(url).unwrap_err();
        assert!(matches!(err, AuthError::BadCallback(_)));
    }

    #[test]
    fn parse_callback_rejects_missing_state() {
        let url = "meeting-intelligence://auth/callback?code=abc";
        let err = parse_callback(url).unwrap_err();
        assert!(matches!(err, AuthError::BadCallback(_)));
    }

    #[test]
    fn parse_callback_rejects_wrong_scheme() {
        let url = "https://example.com/auth/callback?code=abc&state=xyz";
        let err = parse_callback(url).unwrap_err();
        assert!(matches!(err, AuthError::BadCallback(_)));
    }

    #[test]
    fn jwt_exp_seconds_decodes_unsigned_payload() {
        // Header "{}", payload {"exp": 9999999999}, sig "x" — sig
        // contents irrelevant since we don't verify.
        let header = URL_SAFE_NO_PAD.encode(b"{}");
        let payload = URL_SAFE_NO_PAD.encode(br#"{"exp":9999999999}"#);
        let token = format!("{header}.{payload}.x");
        assert_eq!(jwt_exp_seconds(&token), Some(9_999_999_999));
    }

    #[test]
    fn jwt_exp_seconds_returns_none_for_garbage() {
        assert_eq!(jwt_exp_seconds("not a jwt"), None);
        assert_eq!(jwt_exp_seconds("a.b"), None); // wrong segment count
        assert_eq!(jwt_exp_seconds("a.b.c.d"), None);
    }

    #[test]
    fn token_near_expiry_handles_skew() {
        let header = URL_SAFE_NO_PAD.encode(b"{}");
        let payload = URL_SAFE_NO_PAD.encode(br#"{"exp":1000}"#);
        let token = format!("{header}.{payload}.x");
        // Now=900, skew=60 — exp=1000 ≤ 960? No, but ≤ 990? Still no.
        assert!(!token_near_expiry(&token, 900, 60));
        // Now=941, skew=60 — exp=1000 ≤ 1001? Yes.
        assert!(token_near_expiry(&token, 941, 60));
        // Past expiry, no skew.
        assert!(token_near_expiry(&token, 1500, 0));
    }

    #[test]
    fn urlencoding_passes_safe_chars_through() {
        assert_eq!(urlencoding("abcXYZ012-_.~"), "abcXYZ012-_.~");
    }

    #[test]
    fn urlencoding_escapes_unsafe_chars() {
        assert_eq!(urlencoding("a b"), "a%20b");
        assert_eq!(urlencoding("a&b=c"), "a%26b%3Dc");
    }
}
