import { beforeEach, describe, expect, it } from "vitest";

import { useConnectionStore } from "./connection-store";

const state = () => useConnectionStore.getState();

describe("connection-store", () => {
  beforeEach(() => {
    useConnectionStore.getState().reset();
  });

  it("starts idle with zero counters", () => {
    expect(state().phase).toEqual({ kind: "idle" });
    expect(state().bufferedChunkCount).toBe(0);
    expect(state().droppedChunkCount).toBe(0);
  });

  it("accepts each phase variant verbatim", () => {
    state().setPhase({ kind: "connecting", attempt: 0 });
    expect(state().phase).toEqual({ kind: "connecting", attempt: 0 });

    state().setPhase({ kind: "open" });
    expect(state().phase).toEqual({ kind: "open" });

    state().setPhase({ kind: "reconnecting", attempt: 2, nextRetryAtMs: 12_345 });
    expect(state().phase).toEqual({ kind: "reconnecting", attempt: 2, nextRetryAtMs: 12_345 });

    state().setPhase({ kind: "failed", failedAtMs: 99_999, reason: "x" });
    expect(state().phase).toEqual({ kind: "failed", failedAtMs: 99_999, reason: "x" });
  });

  it("setBufferedCount and setDroppedCount move the counters", () => {
    state().setBufferedCount(7);
    state().setDroppedCount(3);
    expect(state().bufferedChunkCount).toBe(7);
    expect(state().droppedChunkCount).toBe(3);
  });

  it("reset returns to idle and zeros counters", () => {
    state().setPhase({ kind: "open" });
    state().setBufferedCount(5);
    state().setDroppedCount(2);
    state().reset();

    expect(state().phase).toEqual({ kind: "idle" });
    expect(state().bufferedChunkCount).toBe(0);
    expect(state().droppedChunkCount).toBe(0);
  });
});
