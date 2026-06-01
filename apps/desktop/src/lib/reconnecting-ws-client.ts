import type {
  ClientWsMessage,
  ServerWsMessage,
} from "@meeting-intelligence/shared-types";

import { AudioRingBuffer } from "./audio-buffer";
import { nextDelayMs, withJitter } from "./backoff";
import {
  connectTranscriptWs as defaultConnectFn,
  type TranscriptWsClient,
  type TranscriptWsHandlers,
} from "./ws-client";

/**
 * Phase-1 reconnect contract:
 *   - Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s… capped at 30s.
 *   - Total budget 5 minutes from the first failure.
 *   - Up to 30 audio chunks (≈30s at 1 chunk/s) buffered while disconnected,
 *     drained in FIFO order on reopen. Oldest dropped on overflow.
 *
 * Server-side resume tokens, ack frames, and meeting persistence are
 * Phase 2 — out of scope for this slice. Each underlying WS connection
 * spawns a fresh STT session on the server, so the post-reconnect
 * transcript is *not* seamlessly stitched. The UI layer is responsible
 * for surfacing that to the user.
 *
 * Backpressure (`error{code: AUDIO_BACKPRESSURE, recoverable: true}`)
 * is propagated unchanged through `onMessage` — this wrapper does not
 * throttle.
 */

export type ConnectionPhase =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "open" }
  | { kind: "reconnecting"; attempt: number; nextRetryAtMs: number }
  | { kind: "failed"; failedAtMs: number; reason: string };

export interface ReconnectingWsHandlers {
  onMessage: (msg: ServerWsMessage) => void;
  onReconnected?: () => void;
  onReconnectFailed?: (reason: string) => void;
  onParseError?: (raw: string, err: unknown) => void;
}

export interface ReconnectingWsObserver {
  phase: ConnectionPhase;
  bufferedChunkCount: number;
  droppedChunkCount: number;
}

export interface ReconnectingWsOpts {
  /** Override the per-attempt delay schedule. Defaults to `nextDelayMs`. */
  backoffSchedule?: (attempt: number) => number;
  /** Disable jitter for deterministic tests. Defaults to true. */
  jitter?: boolean;
  /** Total wall-clock budget for retries before giving up. Defaults to 5 min. */
  maxBudgetMs?: number;
  /** Maximum buffered chunks while disconnected. Defaults to 30. */
  maxBufferedChunks?: number;
  /** Injection seam for tests. Defaults to the real `connectTranscriptWs`. */
  connectFn?: (
    sessionId: string,
    handlers: TranscriptWsHandlers,
  ) => TranscriptWsClient;
  /** Injection seam for tests — `Date.now()` by default. */
  now?: () => number;
}

export interface ReconnectingWsClient {
  send: (msg: ClientWsMessage) => void;
  close: () => void;
  getPhase: () => ConnectionPhase;
  getBufferedCount: () => number;
  getDroppedCount: () => number;
  subscribe: (listener: (snap: ReconnectingWsObserver) => void) => () => void;
}

const DEFAULT_BUDGET_MS = 5 * 60_000;
const DEFAULT_MAX_BUFFERED = 30;
const DRAIN_YIELD_EVERY = 10;

export function createReconnectingWsClient(
  sessionId: string,
  handlers: ReconnectingWsHandlers,
  opts: ReconnectingWsOpts = {},
): ReconnectingWsClient {
  const schedule = opts.backoffSchedule ?? nextDelayMs;
  const useJitter = opts.jitter ?? true;
  const budgetMs = opts.maxBudgetMs ?? DEFAULT_BUDGET_MS;
  const maxBuffered = opts.maxBufferedChunks ?? DEFAULT_MAX_BUFFERED;
  const connectFn = opts.connectFn ?? defaultConnectFn;
  const now = opts.now ?? (() => Date.now());

  const buffer = new AudioRingBuffer<ClientWsMessage>(maxBuffered);
  const listeners = new Set<(snap: ReconnectingWsObserver) => void>();

  let phase: ConnectionPhase = { kind: "idle" };
  let attempt = 0;
  let firstFailureAtMs: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let underlying: TranscriptWsClient | null = null;
  let userClosed = false;

  const snapshot = (): ReconnectingWsObserver => ({
    phase,
    bufferedChunkCount: buffer.size(),
    droppedChunkCount: buffer.droppedCount(),
  });

  const emit = () => {
    const snap = snapshot();
    for (const l of listeners) {
      try {
        l(snap);
      } catch (err) {
        // A listener throwing must not break the state machine.
        console.error("[reconnecting-ws] listener threw", err);
      }
    }
  };

  const setPhase = (next: ConnectionPhase) => {
    phase = next;
    emit();
  };

  const cancelRetryTimer = () => {
    if (retryTimer != null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleNextAttempt = () => {
    if (userClosed) return;
    if (firstFailureAtMs == null) firstFailureAtMs = now();

    if (now() - firstFailureAtMs >= budgetMs) {
      setPhase({
        kind: "failed",
        failedAtMs: now(),
        reason: "reconnect-budget-exhausted",
      });
      try {
        handlers.onReconnectFailed?.("reconnect-budget-exhausted");
      } catch (err) {
        console.error("[reconnecting-ws] onReconnectFailed threw", err);
      }
      return;
    }

    const baseDelay = schedule(attempt);
    const delay = useJitter ? withJitter(baseDelay) : baseDelay;
    const nextRetryAtMs = now() + delay;
    setPhase({ kind: "reconnecting", attempt, nextRetryAtMs });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attempt += 1;
      openOnce();
    }, delay);
  };

  const drainBuffer = () => {
    if (buffer.size() === 0) return;
    const flushBatch = () => {
      let n = 0;
      while (buffer.size() > 0 && n < DRAIN_YIELD_EVERY) {
        const item = buffer.shift();
        if (item) underlying?.send(item);
        n += 1;
      }
      emit();
      if (buffer.size() > 0) {
        setTimeout(flushBatch, 0);
      }
    };
    flushBatch();
  };

  const handleClose = () => {
    underlying = null;
    if (userClosed) {
      setPhase({ kind: "idle" });
      return;
    }
    if (phase.kind === "open") {
      // First failure of an established session — reset attempt counter
      // and anchor the budget here.
      attempt = 0;
      firstFailureAtMs = now();
    }
    scheduleNextAttempt();
  };

  const openOnce = () => {
    if (userClosed) return;
    setPhase({ kind: "connecting", attempt });

    let openHandled = false;
    let closeHandled = false;

    const wsHandlers: TranscriptWsHandlers = {
      onOpen: () => {
        openHandled = true;
        const wasReconnect = firstFailureAtMs != null;
        firstFailureAtMs = null;
        attempt = 0;
        setPhase({ kind: "open" });
        if (wasReconnect) {
          try {
            handlers.onReconnected?.();
          } catch (err) {
            console.error("[reconnecting-ws] onReconnected threw", err);
          }
        }
        drainBuffer();
      },
      onClose: () => {
        if (closeHandled) return;
        closeHandled = true;
        // If we never reached open, treat as connect failure → next attempt.
        if (!openHandled) {
          underlying = null;
          if (userClosed) {
            setPhase({ kind: "idle" });
            return;
          }
          scheduleNextAttempt();
          return;
        }
        handleClose();
      },
      onError: () => {
        // Errors before open: rely on the close that follows. If a stray
        // error lands after open without a close, the next close handles it.
      },
      onMessage: (msg) => {
        try {
          handlers.onMessage(msg);
        } catch (err) {
          console.error("[reconnecting-ws] onMessage threw", err);
        }
      },
      onParseError: (raw, err) => handlers.onParseError?.(raw, err),
    };

    underlying = connectFn(sessionId, wsHandlers);
  };

  // Public API ---------------------------------------------------------

  const send = (msg: ClientWsMessage) => {
    if (userClosed || phase.kind === "failed" || phase.kind === "idle") {
      console.warn("[reconnecting-ws] dropping message — client not active", msg.type);
      return;
    }
    if (phase.kind === "open" && underlying) {
      underlying.send(msg);
      return;
    }
    // connecting or reconnecting
    if (msg.type === "audio_chunk") {
      buffer.push(msg);
      emit();
    } else {
      console.warn(
        "[reconnecting-ws] dropping non-audio frame during reconnect:",
        msg.type,
      );
    }
  };

  const close = () => {
    if (userClosed) return;
    userClosed = true;
    cancelRetryTimer();
    const u = underlying;
    underlying = null;
    if (u) {
      try {
        u.close();
      } catch (err) {
        console.error("[reconnecting-ws] underlying.close() threw", err);
      }
    }
    setPhase({ kind: "idle" });
  };

  const subscribe = (listener: (snap: ReconnectingWsObserver) => void) => {
    listeners.add(listener);
    listener(snapshot());
    return () => {
      listeners.delete(listener);
    };
  };

  // Kick off the first connect attempt synchronously, mirroring
  // `connectTranscriptWs` behavior.
  openOnce();

  return {
    send,
    close,
    getPhase: () => phase,
    getBufferedCount: () => buffer.size(),
    getDroppedCount: () => buffer.droppedCount(),
    subscribe,
  };
}
