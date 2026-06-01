import { create } from "zustand";

export type RecordingPhase =
  | "idle"
  | "checking-permissions"
  | "requesting-permissions"
  | "starting"
  | "recording"
  | "stopping"
  | "stopped";

/**
 * Combined permission state across the two macOS gates we care about.
 * `unknown` until the first `checkAudioPermissions` resolves.
 */
export type AudioPermissionState =
  | "unknown"
  | "granted"
  | "denied"
  | "not-determined";

export interface RecordingState {
  phase: RecordingPhase;
  sessionId: string | null;
  startedAt: string | null;
  startedAtMs: number | null;
  endedAt: string | null;
  durationMs: number;
  elapsedMs: number;
  error: string | null;
  /**
   * Aggregated permission state — `granted` only when *both* mic and
   * screen are granted. The `unknown` -> known transition happens on
   * first launch; the `not-determined` state means we should show
   * the permission prompt before starting capture.
   */
  permissionState: AudioPermissionState;

  // Transitions — illegal calls are no-ops so reducers stay forgiving.
  setPermissionState: (state: AudioPermissionState) => void;
  beginPermissionCheck: () => void;
  beginPermissionRequest: () => void;
  requestStart: () => void;
  confirmStart: (args: { sessionId: string; startedAt: string; nowMs?: number }) => void;
  cancelStart: (error: string) => void;
  requestStop: () => void;
  confirmStop: (args: { endedAt: string; durationMs: number }) => void;
  reset: () => void;
  tick: (nowMs: number) => void;
}

const initial = {
  phase: "idle" as RecordingPhase,
  sessionId: null,
  startedAt: null,
  startedAtMs: null,
  endedAt: null,
  durationMs: 0,
  elapsedMs: 0,
  error: null,
  permissionState: "unknown" as AudioPermissionState,
};

export const useRecordingStore = create<RecordingState>((set, get) => ({
  ...initial,

  setPermissionState: (state) => set({ permissionState: state }),

  beginPermissionCheck: () => {
    if (get().phase === "idle" || get().phase === "stopped") {
      set({ phase: "checking-permissions", error: null });
    }
  },

  beginPermissionRequest: () => {
    if (
      get().phase === "checking-permissions" ||
      get().phase === "idle" ||
      get().phase === "stopped"
    ) {
      set({ phase: "requesting-permissions", error: null });
    }
  },

  requestStart: () => {
    const phase = get().phase;
    // Allow start from idle or after a perm flow has finished.
    if (
      phase !== "idle" &&
      phase !== "stopped" &&
      phase !== "checking-permissions" &&
      phase !== "requesting-permissions"
    ) {
      return;
    }
    set({ phase: "starting", error: null });
  },

  confirmStart: ({ sessionId, startedAt, nowMs }) => {
    if (get().phase !== "starting") return;
    set({
      phase: "recording",
      sessionId,
      startedAt,
      startedAtMs: nowMs ?? Date.now(),
      elapsedMs: 0,
      durationMs: 0,
      endedAt: null,
    });
  },

  cancelStart: (error) => {
    const phase = get().phase;
    if (
      phase !== "starting" &&
      phase !== "checking-permissions" &&
      phase !== "requesting-permissions"
    ) {
      return;
    }
    // Preserve the current permission state across cancellation —
    // the user only re-rolls perms if they ask to.
    set({ ...initial, permissionState: get().permissionState, error });
  },

  requestStop: () => {
    if (get().phase !== "recording") return;
    set({ phase: "stopping" });
  },

  confirmStop: ({ endedAt, durationMs }) => {
    if (get().phase !== "stopping") return;
    set({ phase: "stopped", endedAt, durationMs, elapsedMs: durationMs });
  },

  reset: () => {
    set({ ...initial });
  },

  tick: (nowMs) => {
    const { phase, startedAtMs } = get();
    if (phase !== "recording" || startedAtMs == null) return;
    set({ elapsedMs: Math.max(0, nowMs - startedAtMs) });
  },
}));
