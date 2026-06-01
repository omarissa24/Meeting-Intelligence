import { useCallback, useEffect, useRef } from "react";

import {
  subscribeAudioChunks,
  subscribeAudioErrors,
  type AudioChunkPayload,
} from "@/lib/audio-bridge";
import {
  createReconnectingWsClient,
  type ReconnectingWsClient,
} from "@/lib/reconnecting-ws-client";
import {
  checkAudioPermissions,
  requestAudioPermissions,
  startRecording,
  stopRecording,
  type PermissionsSnapshot,
  type PermState,
} from "@/lib/tauri-commands";
import {
  useConnectionStore,
} from "@/stores/connection-store";
import {
  useRecordingStore,
  type AudioPermissionState,
} from "@/stores/recording-store";
import { useTranscriptStore } from "@/stores/transcript-store";

/**
 * Glue between the Zustand stores, the Tauri commands, the audio
 * bridge, and the /transcript/ws connection. Owns: the elapsed-ms
 * ticker, the WS lifecycle, the audio-chunk subscription, the
 * audio-error subscription, the permission flow, and the auto-stop
 * fallback when the reconnect budget is exhausted.
 *
 * Connection state lives in `connection-store`, not here — the WS
 * client is the sole writer.
 */
export function useRecording() {
  const phase = useRecordingStore((s) => s.phase);
  const sessionId = useRecordingStore((s) => s.sessionId);
  const elapsedMs = useRecordingStore((s) => s.elapsedMs);
  const error = useRecordingStore((s) => s.error);
  const permissionState = useRecordingStore((s) => s.permissionState);
  const setPermissionState = useRecordingStore((s) => s.setPermissionState);
  const beginPermissionCheck = useRecordingStore((s) => s.beginPermissionCheck);
  const beginPermissionRequest = useRecordingStore(
    (s) => s.beginPermissionRequest,
  );
  const requestStart = useRecordingStore((s) => s.requestStart);
  const confirmStart = useRecordingStore((s) => s.confirmStart);
  const cancelStart = useRecordingStore((s) => s.cancelStart);
  const requestStop = useRecordingStore((s) => s.requestStop);
  const confirmStop = useRecordingStore((s) => s.confirmStop);
  const tick = useRecordingStore((s) => s.tick);

  const appendLine = useTranscriptStore((s) => s.appendLine);
  const appendSystemNote = useTranscriptStore((s) => s.appendSystemNote);
  const clearLines = useTranscriptStore((s) => s.clear);

  const setConnPhase = useConnectionStore((s) => s.setPhase);
  const setBufferedCount = useConnectionStore((s) => s.setBufferedCount);
  const setDroppedCount = useConnectionStore((s) => s.setDroppedCount);
  const resetConnection = useConnectionStore((s) => s.reset);

  const wsRef = useRef<ReconnectingWsClient | null>(null);
  const wsUnsubRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // The Tauri event-listener unsubscribers — installed after WS open,
  // torn down on stop. Held in refs so the callbacks don't need to
  // re-subscribe across renders.
  const audioUnlistenRef = useRef<(() => void) | null>(null);
  const errorUnlistenRef = useRef<(() => void) | null>(null);
  // Guard against double-firing the auto-stop when phase flips to failed.
  const autoStopFiredRef = useRef(false);

  // Drive the elapsed timer at 250ms — under the perceptual threshold for
  // a mm:ss display, well above 60fps so the layout never thrashes.
  useEffect(() => {
    if (phase !== "recording") return;
    const interval = window.setInterval(() => tick(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [phase, tick]);

  // First-launch read of permission state. Runs once; the start flow
  // re-reads if the user has changed System Settings since.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snap = await checkAudioPermissions();
        if (!cancelled) setPermissionState(toAggregate(snap));
      } catch {
        // Non-macOS: command returns Err. Stay at "unknown" so the UI
        // still surfaces as not-yet-checked rather than denied.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setPermissionState]);

  const teardownWs = useCallback(() => {
    if (audioUnlistenRef.current) {
      audioUnlistenRef.current();
      audioUnlistenRef.current = null;
    }
    if (errorUnlistenRef.current) {
      errorUnlistenRef.current();
      errorUnlistenRef.current = null;
    }
    if (wsUnsubRef.current) {
      wsUnsubRef.current();
      wsUnsubRef.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    sessionIdRef.current = null;
    resetConnection();
  }, [resetConnection]);

  /**
   * Drive the OS prompts (mic + screen recording) and write the
   * resulting state into the store. Caller (e.g. <PermissionPrompt>'s
   * Continue button) decides when to invoke this. Returns the
   * aggregate state the caller can act on without re-reading the
   * store.
   */
  const requestPermissions = useCallback(async (): Promise<AudioPermissionState> => {
    beginPermissionRequest();
    try {
      const snap = await requestAudioPermissions();
      const next = toAggregate(snap);
      setPermissionState(next);
      // The store's beginPermissionRequest moved phase out of idle;
      // bring it back so the Record button isn't stuck disabled if
      // the user denied.
      cancelStart(next === "denied" ? denialMessage(snap.mic, snap.screen) : "");
      return next;
    } catch (err) {
      cancelStart(
        err instanceof Error ? err.message : "permission request failed",
      );
      return "denied";
    }
  }, [beginPermissionRequest, cancelStart, setPermissionState]);

  const stop = useCallback(async () => {
    requestStop();
    teardownWs();
    try {
      const result = await stopRecording();
      confirmStop({ endedAt: result.endedAt, durationMs: result.durationMs });
    } catch (err) {
      // Stop should always land — if the Rust side reports NotRecording, fall
      // back to a synthetic stop so the UI returns to a usable state.
      confirmStop({
        endedAt: new Date().toISOString(),
        durationMs: 0,
      });
      console.error("stop_recording failed", err);
    }
  }, [confirmStop, requestStop, teardownWs]);

  const start = useCallback(async () => {
    // 1. Permission gate. Re-check live so a fresh System-Settings
    //    grant is reflected immediately. If denied, abort with a
    //    user-actionable error; if not-determined, leave the store
    //    in `not-determined` so AppShell shows the explainer dialog.
    beginPermissionCheck();
    let snap: PermissionsSnapshot;
    try {
      snap = await checkAudioPermissions();
    } catch (err) {
      cancelStart(
        err instanceof Error
          ? err.message
          : "permission check failed; native audio capture may not be available on this platform",
      );
      return;
    }
    const aggregate = toAggregate(snap);
    setPermissionState(aggregate);

    if (aggregate === "not-determined") {
      // Roll the phase back to idle and let the explainer dialog
      // drive the prompt — we don't auto-fire OS prompts here.
      cancelStart("");
      return;
    }
    if (aggregate === "denied") {
      cancelStart(denialMessage(snap.mic, snap.screen));
      return;
    }

    // 2. Now we've got grants — kick off the Rust session.
    requestStart();
    let result;
    try {
      result = await startRecording();
    } catch (err) {
      cancelStart(err instanceof Error ? err.message : String(err));
      return;
    }
    clearLines();
    confirmStart({
      sessionId: result.sessionId,
      startedAt: result.startedAt,
      nowMs: Date.now(),
    });

    // 3. Open the reconnecting WebSocket and wire the audio bridge.
    autoStopFiredRef.current = false;
    sessionIdRef.current = result.sessionId;
    resetConnection();

    const client = createReconnectingWsClient(result.sessionId, {
      onMessage: (msg) => {
        switch (msg.type) {
          case "transcript_line":
            appendLine(msg.line);
            break;
          case "session_started":
          case "session_ended":
          case "error":
            // Surface via UI later if needed.
            break;
        }
      },
      onReconnected: () => {
        const sid = sessionIdRef.current;
        if (sid) {
          appendSystemNote({
            sessionId: sid,
            text: "Reconnected. A short gap may appear in the transcript while we caught up.",
          });
        }
      },
      onReconnectFailed: () => {
        const sid = sessionIdRef.current;
        if (sid) {
          appendSystemNote({
            sessionId: sid,
            text: "Connection lost. Session stopped automatically after 5 minutes of failed reconnects.",
          });
        }
        if (!autoStopFiredRef.current) {
          autoStopFiredRef.current = true;
          void stop();
        }
      },
    });
    wsRef.current = client;
    wsUnsubRef.current = client.subscribe((snap) => {
      setConnPhase(snap.phase);
      setBufferedCount(snap.bufferedChunkCount);
      setDroppedCount(snap.droppedChunkCount);
    });

    // Subscribe to native audio events. The reconnecting client buffers
    // chunks while disconnected, so we don't have to gate on phase here.
    try {
      audioUnlistenRef.current = await subscribeAudioChunks(
        result.sessionId,
        (payload: AudioChunkPayload) => {
          wsRef.current?.send({
            type: "audio_chunk",
            sessionId: payload.sessionId,
            seq: payload.seq,
            pcmBase64: payload.pcmBase64,
          });
        },
      );
      errorUnlistenRef.current = await subscribeAudioErrors(
        result.sessionId,
        (payload) => {
          if (!payload.recoverable) {
            void stop();
          }
          cancelStart(`${payload.code}: ${payload.message}`);
        },
      );
    } catch (err) {
      console.error("failed to subscribe to audio events", err);
    }
  }, [
    appendLine,
    appendSystemNote,
    beginPermissionCheck,
    beginPermissionRequest,
    cancelStart,
    clearLines,
    confirmStart,
    requestStart,
    resetConnection,
    setBufferedCount,
    setConnPhase,
    setDroppedCount,
    setPermissionState,
    stop,
  ]);

  // Clean up the socket if the component using this hook unmounts mid-session.
  useEffect(() => {
    return () => {
      teardownWs();
    };
  }, [teardownWs]);

  return {
    phase,
    sessionId,
    elapsedMs,
    error,
    permissionState,
    start,
    stop,
    requestPermissions,
  };
}

/**
 * Reduce the per-gate snapshot to a single aggregate state. Both
 * gates must be granted for the recorder to start; any denial is a
 * blocker; any not-determined puts us in prompt territory.
 */
function toAggregate(snap: PermissionsSnapshot): AudioPermissionState {
  if (snap.mic === "denied" || snap.screen === "denied") return "denied";
  if (snap.mic === "not-determined" || snap.screen === "not-determined")
    return "not-determined";
  if (snap.mic === "granted" && snap.screen === "granted") return "granted";
  return "unknown";
}

function denialMessage(mic: PermState, screen: PermState): string {
  if (mic === "denied" && screen === "denied") {
    return "Microphone and Screen Recording access are denied. Open System Settings → Privacy & Security to enable both.";
  }
  if (mic === "denied") {
    return "Microphone access is denied. Open System Settings → Privacy & Security → Microphone.";
  }
  return "Screen Recording access is denied. Open System Settings → Privacy & Security → Screen & System Audio Recording.";
}
