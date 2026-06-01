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

export async function startRecording(): Promise<StartRecordingResult> {
  return invoke<StartRecordingResult>("start_recording");
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
