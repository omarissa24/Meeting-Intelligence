import { useCallback, useEffect, useRef, useState } from "react";

import { startRecording, stopRecording } from "@/lib/tauri-commands";
import { connectTranscriptWs, type TranscriptWsClient, type WsReadyState } from "@/lib/ws-client";
import { useRecordingStore } from "@/stores/recording-store";
import { useTranscriptStore } from "@/stores/transcript-store";

/**
 * Glue between the Zustand stores, the Tauri command stubs, and the
 * /transcript/ws connection. Owns the elapsed-ms ticker and the WS
 * lifecycle so components only consume primitive state.
 */
export function useRecording() {
  const phase = useRecordingStore((s) => s.phase);
  const sessionId = useRecordingStore((s) => s.sessionId);
  const elapsedMs = useRecordingStore((s) => s.elapsedMs);
  const error = useRecordingStore((s) => s.error);
  const requestStart = useRecordingStore((s) => s.requestStart);
  const confirmStart = useRecordingStore((s) => s.confirmStart);
  const cancelStart = useRecordingStore((s) => s.cancelStart);
  const requestStop = useRecordingStore((s) => s.requestStop);
  const confirmStop = useRecordingStore((s) => s.confirmStop);
  const tick = useRecordingStore((s) => s.tick);

  const appendLine = useTranscriptStore((s) => s.appendLine);
  const clearLines = useTranscriptStore((s) => s.clear);

  const wsRef = useRef<TranscriptWsClient | null>(null);
  const [wsState, setWsState] = useState<WsReadyState>("closed");

  // Drive the elapsed timer at 250ms — under the perceptual threshold for
  // a mm:ss display, well above 60fps so the layout never thrashes.
  useEffect(() => {
    if (phase !== "recording") return;
    const interval = window.setInterval(() => tick(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [phase, tick]);

  const start = useCallback(async () => {
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

    setWsState("connecting");
    wsRef.current = connectTranscriptWs(result.sessionId, {
      onOpen: () => setWsState("open"),
      onClose: () => setWsState("closed"),
      onError: () => setWsState("closed"),
      onMessage: (msg) => {
        switch (msg.type) {
          case "transcript_line":
            appendLine(msg.line);
            break;
          case "session_started":
          case "session_ended":
          case "error":
            // Foundation slice: surface via UI later if needed.
            break;
        }
      },
    });
  }, [appendLine, cancelStart, clearLines, confirmStart, requestStart]);

  const stop = useCallback(async () => {
    requestStop();
    wsRef.current?.close();
    wsRef.current = null;
    setWsState("closed");
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
  }, [confirmStop, requestStop]);

  // Clean up the socket if the component using this hook unmounts mid-session.
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  return { phase, sessionId, elapsedMs, error, wsState, start, stop };
}
