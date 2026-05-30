import { beforeEach, describe, expect, it } from "vitest";

import { useRecordingStore } from "./recording-store";

const state = () => useRecordingStore.getState();

describe("recording-store state machine", () => {
  beforeEach(() => {
    useRecordingStore.getState().reset();
  });

  it("starts in idle with no session", () => {
    const s = state();
    expect(s.phase).toBe("idle");
    expect(s.sessionId).toBeNull();
    expect(s.elapsedMs).toBe(0);
    expect(s.error).toBeNull();
  });

  it("idle → starting → recording on a happy-path start", () => {
    state().requestStart();
    expect(state().phase).toBe("starting");

    state().confirmStart({
      sessionId: "sess-1",
      startedAt: "2026-05-31T01:00:00Z",
      nowMs: 1_000,
    });

    const s = state();
    expect(s.phase).toBe("recording");
    expect(s.sessionId).toBe("sess-1");
    expect(s.startedAtMs).toBe(1_000);
  });

  it("starting → idle when start_recording rejects, error recorded", () => {
    state().requestStart();
    state().cancelStart("permission denied");

    const s = state();
    expect(s.phase).toBe("idle");
    expect(s.sessionId).toBeNull();
    expect(s.error).toBe("permission denied");
  });

  it("recording → stopping → stopped on a happy-path stop", () => {
    state().requestStart();
    state().confirmStart({ sessionId: "sess-2", startedAt: "x", nowMs: 0 });
    state().requestStop();
    expect(state().phase).toBe("stopping");

    state().confirmStop({ endedAt: "2026-05-31T01:05:00Z", durationMs: 300_000 });

    const s = state();
    expect(s.phase).toBe("stopped");
    expect(s.endedAt).toBe("2026-05-31T01:05:00Z");
    expect(s.durationMs).toBe(300_000);
    expect(s.elapsedMs).toBe(300_000);
  });

  it("reset returns to idle from any phase", () => {
    state().requestStart();
    state().confirmStart({ sessionId: "sess-3", startedAt: "x", nowMs: 0 });
    state().requestStop();
    state().reset();

    expect(state().phase).toBe("idle");
    expect(state().sessionId).toBeNull();
    expect(state().error).toBeNull();
  });

  it("ignores requestStop() while idle", () => {
    state().requestStop();
    expect(state().phase).toBe("idle");
  });

  it("ignores requestStart() while already recording", () => {
    state().requestStart();
    state().confirmStart({ sessionId: "sess-4", startedAt: "x", nowMs: 0 });
    state().requestStart();
    expect(state().phase).toBe("recording");
    expect(state().sessionId).toBe("sess-4");
  });

  it("ignores confirmStart unless phase is starting", () => {
    // From idle — should be ignored.
    state().confirmStart({ sessionId: "phantom", startedAt: "x", nowMs: 0 });
    expect(state().phase).toBe("idle");
    expect(state().sessionId).toBeNull();
  });

  it("ignores confirmStop unless phase is stopping", () => {
    state().requestStart();
    state().confirmStart({ sessionId: "sess-5", startedAt: "x", nowMs: 0 });
    state().confirmStop({ endedAt: "y", durationMs: 1 });
    expect(state().phase).toBe("recording");
  });

  it("tick(now) updates elapsedMs only while recording", () => {
    state().requestStart();
    state().confirmStart({ sessionId: "sess-6", startedAt: "x", nowMs: 10_000 });
    state().tick(12_500);
    expect(state().elapsedMs).toBe(2_500);

    state().reset();
    state().tick(99_999);
    expect(state().elapsedMs).toBe(0);
  });

  it("tick never lets elapsedMs go negative if clock jitters backward", () => {
    state().requestStart();
    state().confirmStart({ sessionId: "sess-7", startedAt: "x", nowMs: 10_000 });
    state().tick(9_000);
    expect(state().elapsedMs).toBe(0);
  });
});
