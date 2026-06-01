import { create } from "zustand";

/**
 * Lives separately from `recording-store` so high-frequency buffer
 * counter updates don't re-render the recording control or the
 * elapsed timer. Components subscribe with selectors against
 * `phase.kind` to avoid pulling the whole tagged union per render.
 *
 * The reconnecting WS client (`lib/reconnecting-ws-client.ts`) is the
 * sole writer; the rest of the app reads.
 */
export type ConnectionPhase =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "open" }
  | { kind: "reconnecting"; attempt: number; nextRetryAtMs: number }
  | { kind: "failed"; failedAtMs: number; reason: string };

export interface ConnectionState {
  phase: ConnectionPhase;
  bufferedChunkCount: number;
  droppedChunkCount: number;

  setPhase: (phase: ConnectionPhase) => void;
  setBufferedCount: (n: number) => void;
  setDroppedCount: (n: number) => void;
  reset: () => void;
}

const initial = {
  phase: { kind: "idle" } as ConnectionPhase,
  bufferedChunkCount: 0,
  droppedChunkCount: 0,
};

export const useConnectionStore = create<ConnectionState>((set) => ({
  ...initial,

  setPhase: (phase) => set({ phase }),
  setBufferedCount: (n) => set({ bufferedChunkCount: n }),
  setDroppedCount: (n) => set({ droppedChunkCount: n }),
  reset: () => set({ ...initial }),
}));
