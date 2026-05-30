import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers around the Rust commands registered in
 * `src-tauri/src/lib.rs`. Camel-case field names match Rust's
 * `#[serde(rename_all = "camelCase")]` annotations on the result types.
 *
 * The foundation-slice stubs return synthetic session ids and timestamps —
 * real audio capture (ScreenCaptureKit / WASAPI) lands in a later slice
 * without changing this surface.
 */

export interface StartRecordingResult {
  sessionId: string;
  startedAt: string;
}

export interface StopRecordingResult {
  sessionId: string;
  endedAt: string;
  durationMs: number;
}

export async function startRecording(): Promise<StartRecordingResult> {
  return invoke<StartRecordingResult>("start_recording");
}

export async function stopRecording(): Promise<StopRecordingResult> {
  return invoke<StopRecordingResult>("stop_recording");
}
