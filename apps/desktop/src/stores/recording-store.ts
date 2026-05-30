import { create } from "zustand";

export type RecordingPhase =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "stopped";

export interface RecordingState {
  phase: RecordingPhase;
  sessionId: string | null;
  startedAt: string | null;
  startedAtMs: number | null;
  endedAt: string | null;
  durationMs: number;
  elapsedMs: number;
  error: string | null;

  // Transitions — illegal calls are no-ops so reducers stay forgiving.
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
};

export const useRecordingStore = create<RecordingState>((set, get) => ({
  ...initial,

  requestStart: () => {
    if (get().phase !== "idle") return;
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
    if (get().phase !== "starting") return;
    set({ ...initial, error });
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
