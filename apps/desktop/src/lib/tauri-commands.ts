import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers around the Rust commands registered in
 * `src-tauri/src/lib.rs`. Camel-case field names match Rust's
 * `#[serde(rename_all = "camelCase")]` annotations on the result types.
 */

export interface StartRecordingResult {
  sessionId: string;
  startedAt: string;
}

/**
 * Capture-side stats reported when the session ends. The shape mirrors
 * `recording::SessionStats` on the Rust side. `undefined` on platforms
 * where native audio capture isn't wired yet (Linux/Windows in this
 * slice).
 */
export interface SessionStats {
  micFramesReceived: number;
  micFramesDropped: number;
  systemFramesReceived: number;
  systemFramesDropped: number;
  vadVoiceFrames: number;
  vadSilenceFrames: number;
  /** Fraction of frames the VAD classified as silence (0..1). */
  vadDropRatio: number;
  chunksEmitted: number;
  samplesIn: number;
  trailingSamplesFlushed: number;
  mixerChunksEmitted: number;
  systemDriftDrops: number;
  micDriftDrops: number;
  micResamplerErrors: number;
  outputDroppedAtEmitter: number;
}

export interface StopRecordingResult {
  sessionId: string;
  endedAt: string;
  durationMs: number;
  /** macOS only for now; absent on other platforms. */
  stats?: SessionStats;
}

export type PermState = "granted" | "denied" | "not-determined";

export interface PermissionsSnapshot {
  mic: PermState;
  screen: PermState;
}

export async function startRecording(sessionId: string): Promise<StartRecordingResult> {
  return invoke<StartRecordingResult>("start_recording", { sessionId });
}

export async function stopRecording(): Promise<StopRecordingResult> {
  return invoke<StopRecordingResult>("stop_recording");
}

export async function checkAudioPermissions(): Promise<PermissionsSnapshot> {
  return invoke<PermissionsSnapshot>("check_audio_permissions");
}

/**
 * Triggers the macOS mic + screen-recording prompts in sequence. The
 * call blocks (in the worker) until the user has dismissed both
 * prompts, then resolves with the resulting state. Polls the
 * ScreenCaptureKit daemon until it observes a fresh grant — see plan
 * risk #3 — so the next `startRecording` doesn't race the daemon.
 */
export async function requestAudioPermissions(): Promise<PermissionsSnapshot> {
  return invoke<PermissionsSnapshot>("request_audio_permissions");
}

// --- Auth (Phase 2 / US-08) ----------------------------------------------

/**
 * Free-form WorkOS user dict — pass-through from the backend's
 * /auth/callback response. Shape varies with WorkOS SDK version, so we
 * keep it as opaque JSON until the UI needs a specific field.
 */
export type AuthUserJson = Record<string, unknown>;

export interface AuthSession {
  user: AuthUserJson;
}

/**
 * Mint a CSRF nonce, persist it Rust-side, and open the system browser
 * at `BACKEND/auth/authorize?state=<nonce>`. AuthKit redirects back via
 * the `meeting-intelligence://auth/callback?code=...&state=...` deep
 * link; the Rust handler validates the nonce, exchanges the code, and
 * emits `auth://session-changed` once tokens are stored.
 */
export async function authStartLogin(): Promise<void> {
  return invoke<void>("auth_start_login");
}

/**
 * Read the cached session out of the OS credential store. Returns
 * `null` when the user isn't signed in — the React `auth-store` calls
 * this on hydrate to decide between `<LoginView/>` and `<AppShell/>`.
 */
export async function authGetSession(): Promise<AuthSession | null> {
  return invoke<AuthSession | null>("auth_get_session");
}

/**
 * Return the current access token, refreshing transparently if it's
 * within 60s of expiring. Returns `null` if the user isn't signed in
 * or the cached refresh token has been rejected. Used by `apiFetch`
 * before every HTTP call and by the WS bearer subprotocol.
 */
export async function authGetAccessToken(): Promise<string | null> {
  return invoke<string | null>("auth_get_access_token");
}

/**
 * Wipe the OS credential store and return the AuthKit logout URL the
 * frontend should open to end the AuthKit session. Empty string is
 * returned if the backend was unreachable — the local clear still
 * counts.
 */
export async function authLogout(): Promise<string> {
  return invoke<string>("auth_logout");
}
