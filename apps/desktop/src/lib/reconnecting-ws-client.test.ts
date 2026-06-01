import type {
  ClientWsMessage,
  ServerWsMessage,
} from "@meeting-intelligence/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createReconnectingWsClient,
  type ReconnectingWsObserver,
} from "./reconnecting-ws-client";
import type {
  TranscriptWsClient,
  TranscriptWsHandlers,
} from "./ws-client";

/**
 * Fake `TranscriptWsClient` factory: each `connect()` call records the
 * handlers it received and exposes `triggerOpen` / `triggerClose` so
 * tests can simulate the WS lifecycle synchronously inside fake-timers.
 */
function makeFakeFactory() {
  type Inst = {
    sessionId: string;
    handlers: TranscriptWsHandlers;
    sent: ClientWsMessage[];
    closed: boolean;
    triggerOpen: () => void;
    triggerClose: () => void;
    triggerMessage: (msg: ServerWsMessage) => void;
    triggerParseError: (raw: string, err: unknown) => void;
  };

  const instances: Inst[] = [];

  const connectFn = (
    sessionId: string,
    handlers: TranscriptWsHandlers,
  ): TranscriptWsClient => {
    const inst: Inst = {
      sessionId,
      handlers,
      sent: [],
      closed: false,
      triggerOpen: () => handlers.onOpen?.(),
      triggerClose: () => handlers.onClose?.(new CloseEvent("close")),
      triggerMessage: (msg) => handlers.onMessage(msg),
      triggerParseError: (raw, err) => handlers.onParseError?.(raw, err),
    };
    instances.push(inst);
    return {
      send: (msg) => inst.sent.push(msg),
      close: () => {
        inst.closed = true;
      },
      get readyState() {
        return inst.closed ? "closed" : "open";
      },
    };
  };

  return { instances, connectFn };
}

const audioMsg = (seq: number): ClientWsMessage => ({
  type: "audio_chunk",
  sessionId: "sess",
  seq,
  pcmBase64: `chunk-${seq}`,
});

describe("createReconnectingWsClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the underlying socket and forwards messages once open", () => {
    const { instances, connectFn } = makeFakeFactory();
    const onMessage = vi.fn();

    const client = createReconnectingWsClient(
      "sess",
      { onMessage },
      { connectFn, jitter: false },
    );

    expect(instances).toHaveLength(1);
    expect(client.getPhase()).toEqual({ kind: "connecting", attempt: 0 });

    instances[0].triggerOpen();
    expect(client.getPhase()).toEqual({ kind: "open" });

    client.send(audioMsg(0));
    expect(instances[0].sent).toEqual([audioMsg(0)]);
  });

  it("transitions to reconnecting on server close and retries on the documented schedule", () => {
    const { instances, connectFn } = makeFakeFactory();
    const onReconnected = vi.fn();
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn(), onReconnected },
      { connectFn, jitter: false },
    );

    instances[0].triggerOpen();
    expect(client.getPhase()).toEqual({ kind: "open" });

    // Server-side close → first reconnect attempt scheduled at 1s.
    instances[0].triggerClose();
    let phase = client.getPhase();
    expect(phase.kind).toBe("reconnecting");
    if (phase.kind === "reconnecting") {
      expect(phase.attempt).toBe(0);
    }

    vi.advanceTimersByTime(1_000);
    expect(instances).toHaveLength(2);
    expect(client.getPhase()).toEqual({ kind: "connecting", attempt: 1 });

    // Connect attempt fails before reaching open → next attempt scheduled at 2s.
    instances[1].triggerClose();
    phase = client.getPhase();
    expect(phase.kind).toBe("reconnecting");
    if (phase.kind === "reconnecting") {
      expect(phase.attempt).toBe(1);
    }
    vi.advanceTimersByTime(2_000);
    expect(instances).toHaveLength(3);

    // Successful reopen fires onReconnected and clears state.
    instances[2].triggerOpen();
    expect(onReconnected).toHaveBeenCalledTimes(1);
    expect(client.getPhase()).toEqual({ kind: "open" });
  });

  it("buffers audio_chunks while reconnecting and drains in FIFO order on reopen", async () => {
    const { instances, connectFn } = makeFakeFactory();
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn() },
      { connectFn, jitter: false, maxBufferedChunks: 30 },
    );

    instances[0].triggerOpen();
    instances[0].triggerClose(); // server drops

    // While reconnecting, audio_chunks must go to the buffer.
    for (let i = 0; i < 5; i++) client.send(audioMsg(i));
    expect(client.getBufferedCount()).toBe(5);

    vi.advanceTimersByTime(1_000); // attempt 1
    instances[1].triggerOpen();

    // Drain runs synchronously for batches ≤10; flush any setTimeout(0).
    await vi.advanceTimersByTimeAsync(10);
    expect(instances[1].sent.map((m) => (m as { pcmBase64: string }).pcmBase64)).toEqual(
      ["chunk-0", "chunk-1", "chunk-2", "chunk-3", "chunk-4"],
    );
    expect(client.getBufferedCount()).toBe(0);
  });

  it("evicts oldest chunks when the buffer overflows", () => {
    const { instances, connectFn } = makeFakeFactory();
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn() },
      { connectFn, jitter: false, maxBufferedChunks: 30 },
    );

    instances[0].triggerOpen();
    instances[0].triggerClose();

    for (let i = 0; i < 35; i++) client.send(audioMsg(i));
    expect(client.getBufferedCount()).toBe(30);
    expect(client.getDroppedCount()).toBe(5);
  });

  it("transitions to failed and fires onReconnectFailed when the 5-min budget is exhausted", () => {
    const { instances, connectFn } = makeFakeFactory();
    const onReconnectFailed = vi.fn();
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn(), onReconnectFailed },
      { connectFn, jitter: false, maxBudgetMs: 5 * 60_000 },
    );

    instances[0].triggerOpen();
    instances[0].triggerClose();

    // Burn through retries. The schedule sums 1+2+4+8+16+30+30+30+… seconds.
    // Drive the loop by repeatedly closing each attempt before it would open.
    let i = 1;
    while (client.getPhase().kind === "reconnecting") {
      vi.advanceTimersByTime(31_000); // step past any single delay
      if (instances[i]) {
        instances[i].triggerClose();
      }
      i += 1;
      if (i > 50) break; // safety
    }

    expect(client.getPhase().kind).toBe("failed");
    expect(onReconnectFailed).toHaveBeenCalledTimes(1);
    expect(onReconnectFailed).toHaveBeenCalledWith("reconnect-budget-exhausted");
  });

  it("user-initiated close cancels any pending retry timer and does not reconnect", () => {
    const { instances, connectFn } = makeFakeFactory();
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn() },
      { connectFn, jitter: false },
    );

    instances[0].triggerOpen();
    instances[0].triggerClose();
    expect(client.getPhase().kind).toBe("reconnecting");

    client.close();
    expect(client.getPhase()).toEqual({ kind: "idle" });

    // Advance well past the would-be 1s retry — no new instance should appear.
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1);
  });

  it("ignores duplicate close() calls", () => {
    const { instances, connectFn } = makeFakeFactory();
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn() },
      { connectFn, jitter: false },
    );
    instances[0].triggerOpen();
    client.close();
    client.close();
    expect(client.getPhase()).toEqual({ kind: "idle" });
  });

  it("forwards server messages to the consumer's onMessage", () => {
    const { instances, connectFn } = makeFakeFactory();
    const onMessage = vi.fn();
    createReconnectingWsClient(
      "sess",
      { onMessage },
      { connectFn, jitter: false },
    );
    instances[0].triggerOpen();
    instances[0].triggerMessage({
      type: "session_started",
      sessionId: "sess",
      startedAt: "2026-06-01T00:00:00Z",
      sttProvider: "echo",
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("drops sends after .close() with a warning, never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { instances, connectFn } = makeFakeFactory();
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn() },
      { connectFn, jitter: false },
    );
    instances[0].triggerOpen();
    client.close();

    expect(() => client.send(audioMsg(0))).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("subscribers receive snapshots on phase + buffer changes", () => {
    const { instances, connectFn } = makeFakeFactory();
    const snaps: ReconnectingWsObserver[] = [];
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn() },
      { connectFn, jitter: false },
    );
    const unsub = client.subscribe((s) => snaps.push(s));

    expect(snaps[0].phase.kind).toBe("connecting");

    instances[0].triggerOpen();
    expect(snaps.at(-1)?.phase.kind).toBe("open");

    instances[0].triggerClose();
    expect(snaps.at(-1)?.phase.kind).toBe("reconnecting");

    client.send(audioMsg(0));
    expect(snaps.at(-1)?.bufferedChunkCount).toBe(1);

    unsub();
    const lenBefore = snaps.length;
    client.send(audioMsg(1));
    expect(snaps.length).toBe(lenBefore); // no further snaps after unsub
  });

  it("applies the documented backoff schedule across consecutive failures", () => {
    // Drive five consecutive close-without-open cycles and assert each
    // retry timer fires at the expected delay: 1s, 2s, 4s, 8s, 16s.
    // (30s caps come later in the schedule; the existing budget test
    // already exercises that ceiling indirectly.)
    const { instances, connectFn } = makeFakeFactory();
    createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn() },
      { connectFn, jitter: false },
    );

    instances[0].triggerOpen();
    instances[0].triggerClose();

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000];
    for (let step = 0; step < expectedDelays.length; step += 1) {
      const delay = expectedDelays[step];
      // 1ms before the deadline → no new instance yet.
      vi.advanceTimersByTime(delay - 1);
      expect(instances).toHaveLength(step + 1);
      // Cross the deadline → new connect spawned.
      vi.advanceTimersByTime(1);
      expect(instances).toHaveLength(step + 2);
      // Fail this attempt before it would open, queueing the next.
      instances[step + 1].triggerClose();
    }
  });

  it("drops non-audio messages while reconnecting and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { instances, connectFn } = makeFakeFactory();
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn() },
      { connectFn, jitter: false },
    );

    instances[0].triggerOpen();
    instances[0].triggerClose();
    expect(client.getPhase().kind).toBe("reconnecting");

    // Non-audio frames (e.g. a hypothetical control message) must NOT
    // be queued — only audio_chunks survive a reconnect. Use a session
    // control type that the union admits but that the buffer ignores.
    client.send({
      type: "audio_chunk",
      sessionId: "sess",
      seq: 1,
      pcmBase64: "ok",
    });
    expect(client.getBufferedCount()).toBe(1);

    // Now try a non-audio frame — buffer count must NOT increase.
    // (We cast through `as unknown` because the message union currently
    // only contains audio_chunk; the runtime path still handles the
    // `else` branch defensively.)
    const nonAudio = { type: "synthetic_non_audio" } as unknown as ClientWsMessage;
    client.send(nonAudio);
    expect(client.getBufferedCount()).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("non-audio"),
      expect.anything(),
    );

    warn.mockRestore();
  });

  it("onReconnected exceptions do not block reconnect completion or buffer drain", async () => {
    const { instances, connectFn } = makeFakeFactory();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onReconnected = vi.fn(() => {
      throw new Error("user handler boom");
    });
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn(), onReconnected },
      { connectFn, jitter: false },
    );

    instances[0].triggerOpen();
    instances[0].triggerClose();

    // Buffer some chunks during the reconnect window.
    for (let i = 0; i < 3; i += 1) client.send(audioMsg(i));

    vi.advanceTimersByTime(1_000); // attempt 1 fires
    instances[1].triggerOpen(); // reopen — onReconnected throws here

    expect(client.getPhase()).toEqual({ kind: "open" });
    expect(onReconnected).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      "[reconnecting-ws] onReconnected threw",
      expect.any(Error),
    );

    // Buffered chunks still drained despite the throw.
    await vi.advanceTimersByTimeAsync(10);
    expect(instances[1].sent).toHaveLength(3);

    errSpy.mockRestore();
  });

  it("onReconnectFailed exceptions are swallowed", () => {
    const { instances, connectFn } = makeFakeFactory();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onReconnectFailed = vi.fn(() => {
      throw new Error("failure handler boom");
    });
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn(), onReconnectFailed },
      // Tiny budget so the second scheduling attempt (after the first
      // retry has burned 1 s of wall clock) exhausts it.
      { connectFn, jitter: false, maxBudgetMs: 1 },
    );

    instances[0].triggerOpen();
    instances[0].triggerClose(); // anchors firstFailureAtMs, schedules t+1000
    // Advance past the first retry delay so attempt 1 spins up.
    vi.advanceTimersByTime(1_000);
    expect(instances).toHaveLength(2);
    // Close that attempt before it opens — `scheduleNextAttempt` will
    // now see elapsed (1000ms) >= budget (1ms) and transition to failed.
    instances[1].triggerClose();

    expect(client.getPhase().kind).toBe("failed");
    expect(onReconnectFailed).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      "[reconnecting-ws] onReconnectFailed threw",
      expect.any(Error),
    );

    errSpy.mockRestore();
  });

  it("forwards parse errors to onParseError when supplied", () => {
    const { instances, connectFn } = makeFakeFactory();
    const onParseError = vi.fn();
    createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn(), onParseError },
      { connectFn, jitter: false },
    );
    instances[0].triggerOpen();
    instances[0].triggerParseError("garbage{", new Error("bad json"));
    expect(onParseError).toHaveBeenCalledWith(
      "garbage{",
      expect.any(Error),
    );
  });

  it("subscribers see drop count incrementing as buffer overflows", () => {
    const { instances, connectFn } = makeFakeFactory();
    const snaps: ReconnectingWsObserver[] = [];
    const client = createReconnectingWsClient(
      "sess",
      { onMessage: vi.fn() },
      { connectFn, jitter: false, maxBufferedChunks: 30 },
    );
    client.subscribe((s) => snaps.push(s));

    instances[0].triggerOpen();
    instances[0].triggerClose();
    for (let i = 0; i < 35; i += 1) client.send(audioMsg(i));

    expect(snaps.at(-1)?.bufferedChunkCount).toBe(30);
    expect(snaps.at(-1)?.droppedChunkCount).toBe(5);
  });
});
