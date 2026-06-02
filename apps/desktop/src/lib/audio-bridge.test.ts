import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AudioChunkPayload,
  AudioErrorPayload,
  PerfStatsPayload,
} from "./audio-bridge";

type Handler<T> = (event: { payload: T }) => void;

type ListenCall = {
  event: string;
  handler: Handler<unknown>;
};

const listenCalls: ListenCall[] = [];
const unlistenSpies: ReturnType<typeof vi.fn>[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async <T>(event: string, handler: Handler<T>) => {
      listenCalls.push({ event, handler: handler as Handler<unknown> });
      const unlisten = vi.fn();
      unlistenSpies.push(unlisten);
      return unlisten;
    },
  ),
}));

beforeEach(() => {
  listenCalls.length = 0;
  unlistenSpies.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

async function importBridge() {
  return import("./audio-bridge");
}

describe("subscribeAudioChunks", () => {
  it("forwards chunks belonging to the session and ignores others", async () => {
    const { subscribeAudioChunks } = await importBridge();
    const onChunk = vi.fn();
    const unlisten = await subscribeAudioChunks("session-A", onChunk);

    expect(listenCalls).toHaveLength(1);
    expect(listenCalls[0].event).toBe("audio://chunk");

    const handler = listenCalls[0].handler as Handler<AudioChunkPayload>;
    handler({
      payload: {
        sessionId: "session-A",
        seq: 1,
        pcmBase64: "AAAA",
        durationMs: 1000,
      },
    });
    handler({
      payload: {
        sessionId: "session-B",
        seq: 1,
        pcmBase64: "AAAA",
        durationMs: 1000,
      },
    });

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk.mock.calls[0][0].sessionId).toBe("session-A");
    expect(unlisten).toBe(unlistenSpies[0]);
  });
});

describe("subscribeAudioErrors", () => {
  it("forwards errors belonging to the session and ignores others", async () => {
    const { subscribeAudioErrors } = await importBridge();
    const onError = vi.fn();
    await subscribeAudioErrors("session-A", onError);

    expect(listenCalls[0].event).toBe("audio://error");
    const handler = listenCalls[0].handler as Handler<AudioErrorPayload>;

    handler({
      payload: {
        sessionId: "session-A",
        code: "AUDIO_DROP",
        message: "boom",
        recoverable: true,
      },
    });
    handler({
      payload: {
        sessionId: "session-B",
        code: "AUDIO_DROP",
        message: "boom",
        recoverable: true,
      },
    });

    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("subscribePerfStats", () => {
  it("subscribes to perf://stats", async () => {
    const { subscribePerfStats } = await importBridge();
    const onStats = vi.fn();
    await subscribePerfStats("session-A", onStats);

    expect(listenCalls).toHaveLength(1);
    expect(listenCalls[0].event).toBe("perf://stats");
  });

  it("forwards stats for the matching session", async () => {
    const { subscribePerfStats } = await importBridge();
    const onStats = vi.fn();
    await subscribePerfStats("session-A", onStats);

    const handler = listenCalls[0].handler as Handler<PerfStatsPayload>;
    const payload: PerfStatsPayload = {
      sessionId: "session-A",
      cpuPercent: 4.2,
      rssMb: 137.5,
      uptimeMs: 1234,
    };
    handler({ payload });

    expect(onStats).toHaveBeenCalledTimes(1);
    expect(onStats.mock.calls[0][0]).toEqual(payload);
  });

  it("filters out stats from other sessions", async () => {
    const { subscribePerfStats } = await importBridge();
    const onStats = vi.fn();
    await subscribePerfStats("session-A", onStats);

    const handler = listenCalls[0].handler as Handler<PerfStatsPayload>;
    handler({
      payload: {
        sessionId: "session-OTHER",
        cpuPercent: 4.2,
        rssMb: 137.5,
        uptimeMs: 1234,
      },
    });

    expect(onStats).not.toHaveBeenCalled();
  });

  it("returns the unlisten function from listen()", async () => {
    const { subscribePerfStats } = await importBridge();
    const unlisten = await subscribePerfStats("session-A", vi.fn());
    expect(unlisten).toBe(unlistenSpies[0]);
  });
});
