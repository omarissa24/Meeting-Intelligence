import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Phase 6 meeting-detection event bridge. Mirrors `audio-bridge.ts`, but the
 * events are app-global (not session-scoped), so there's no `sessionId`
 * filter. Dismissal logic keys on `detectionId` instead, so a stale `ended`
 * can't close a newer prompt.
 */

/**
 * Payload of `meeting://detected`. Mirrors `detection::monitor::
 * MeetingDetectedPayload` (camelCase via serde).
 */
export interface MeetingDetectedPayload {
  /** Registry id (bundle id / process basename) — keys snooze + "never for this app". */
  appId: string;
  displayName: string;
  /** True when matched via a browser (the Google Meet heuristic) — softer copy. */
  isBrowserHeuristic: boolean;
  /** Monotonic id for this detected session; the matching `ended` echoes it. */
  detectionId: number;
}

/** Payload of `meeting://ended`. */
export interface MeetingEndedPayload {
  detectionId: number;
}

const EVENT_MEETING_DETECTED = "meeting://detected";
const EVENT_MEETING_ENDED = "meeting://ended";

/**
 * Subscribe to `meeting://detected`. Returns an unsubscribe function — call it
 * on unmount so the listener doesn't leak. Subscribe once at the app root.
 */
export async function subscribeMeetingDetected(
  onDetected: (payload: MeetingDetectedPayload) => void,
): Promise<UnlistenFn> {
  return listen<MeetingDetectedPayload>(EVENT_MEETING_DETECTED, (event) => {
    onDetected(event.payload);
  });
}

/** Subscribe to `meeting://ended`. */
export async function subscribeMeetingEnded(
  onEnded: (payload: MeetingEndedPayload) => void,
): Promise<UnlistenFn> {
  return listen<MeetingEndedPayload>(EVENT_MEETING_ENDED, (event) => {
    onEnded(event.payload);
  });
}
