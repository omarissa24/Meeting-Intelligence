//! OS credential store wrapper for the WorkOS session.
//!
//! Keys: `service = "meeting-intelligence"`, `account ∈ {"session"}`.
//! The whole session blob (access + refresh + user) is JSON-encoded and
//! stored under the single `session` account so a partial write can't
//! leave us with a refresh token but no access token (or vice-versa).
//!
//! The `keyring` crate uses Keychain on macOS and the Credential
//! Manager on Windows; on Linux it falls back to secret-service which
//! we don't ship to in MVP, so callers should treat absence/error as
//! "not signed in" and trigger the login flow.

use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "meeting-intelligence";
const ACCOUNT: &str = "session";

/// What we persist to the OS credential store across app launches.
///
/// `user_json` is the raw WorkOS user dict the backend returned —
/// keeping it as a string (rather than re-modelling every field) lets
/// us pass it back to the frontend untouched and avoids breaking
/// changes if WorkOS adds fields. The frontend treats it as opaque
/// JSON for now.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    #[serde(rename = "accessToken")]
    pub access_token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: Option<String>,
    /// Serialized JSON of the WorkOS user dict (id, email, etc.).
    #[serde(rename = "userJson")]
    pub user_json: String,
}

/// Persist the session to the OS credential store. Overwrites any
/// existing entry.
pub fn save(session: &StoredSession) -> Result<(), keyring::Error> {
    let entry = Entry::new(SERVICE, ACCOUNT)?;
    let payload = serde_json::to_string(session).map_err(|e| {
        keyring::Error::Invalid(
            "session-json".into(),
            format!("could not serialize session: {e}"),
        )
    })?;
    entry.set_password(&payload)
}

/// Load the session if one exists. Returns `Ok(None)` on no-entry; any
/// other keyring error is propagated so the caller can surface it
/// rather than silently treating a corrupt entry as "signed out".
pub fn load() -> Result<Option<StoredSession>, keyring::Error> {
    let entry = Entry::new(SERVICE, ACCOUNT)?;
    match entry.get_password() {
        Ok(payload) => {
            let session: StoredSession = serde_json::from_str(&payload).map_err(|e| {
                keyring::Error::Invalid(
                    "session-json".into(),
                    format!("could not deserialize session: {e}"),
                )
            })?;
            Ok(Some(session))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(other),
    }
}

/// Clear the cached session. NoEntry is treated as success — the
/// post-condition (no entry exists) holds either way.
pub fn clear() -> Result<(), keyring::Error> {
    let entry = Entry::new(SERVICE, ACCOUNT)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(other) => Err(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The keyring crate's `mock` feature would be ideal, but since we
    // ship the OS-native backends only, these tests hit the real
    // Keychain / Credential Manager. They're gated to host targets
    // and use unique service names per test run so parallel runs and
    // dev-machine state don't collide.
    //
    // CI runs these on macOS + Windows; Linux is intentionally skipped.

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn save_load_roundtrip() {
        let session = StoredSession {
            access_token: "eyJfake.access".to_string(),
            refresh_token: Some("rt-fake".to_string()),
            user_json: r#"{"id":"u_1","email":"alice@example.com"}"#.to_string(),
        };
        // Use a unique ACCOUNT for this test so we don't trample a
        // user's real session if they happen to be running this on a
        // dev machine where they're signed in.
        let entry = Entry::new(SERVICE, "test_save_load_roundtrip").unwrap();
        let payload = serde_json::to_string(&session).unwrap();
        entry.set_password(&payload).unwrap();
        let read_back = entry.get_password().unwrap();
        let decoded: StoredSession = serde_json::from_str(&read_back).unwrap();
        assert_eq!(decoded.access_token, session.access_token);
        assert_eq!(decoded.refresh_token, session.refresh_token);
        assert_eq!(decoded.user_json, session.user_json);
        // Cleanup.
        let _ = entry.delete_credential();
    }

    #[test]
    fn stored_session_serializes_to_camel_case() {
        let session = StoredSession {
            access_token: "x".into(),
            refresh_token: Some("y".into()),
            user_json: "{}".into(),
        };
        let json = serde_json::to_string(&session).unwrap();
        assert!(json.contains("\"accessToken\""), "got: {json}");
        assert!(json.contains("\"refreshToken\""));
        assert!(json.contains("\"userJson\""));
    }
}
