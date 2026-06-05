import type { RecordingPhase } from "@/stores/recording-store";

/**
 * Phase predicates shared by AppShell (which gates the visible History
 * button) and the keyboard-shortcut handler (US-28), so a shortcut never
 * does something the equivalent on-screen affordance wouldn't.
 */

/**
 * History browsing only makes sense when the recording surface is idle —
 * opening it mid-recording would yank the live transcript out from under
 * the user. Idle / permission-flow states are fine.
 */
export function canBrowseHistory(phase: RecordingPhase): boolean {
  return phase === "idle" || phase === "checking-permissions" || phase === "requesting-permissions";
}

/**
 * A fresh recording can start from a cold idle or after a prior session
 * ended. Mirrors the recording-store's `requestStart` guard — important
 * because `start()` runs the whole permission + provision flow and must
 * not be re-entered mid-session.
 */
export function canStartRecording(phase: RecordingPhase): boolean {
  return phase === "idle" || phase === "stopped";
}

/** Stop applies only to a live session. */
export function isRecordingActive(phase: RecordingPhase): boolean {
  return phase === "recording";
}
