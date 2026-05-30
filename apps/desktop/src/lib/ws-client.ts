import type {
  ClientWsMessage,
  ServerWsMessage,
} from "@meeting-intelligence/shared-types";

import { BACKEND_WS_URL, CLIENT_VERSION } from "./config";

export type WsReadyState = "connecting" | "open" | "closing" | "closed";

export interface TranscriptWsHandlers {
  onMessage: (msg: ServerWsMessage) => void;
  onOpen?: () => void;
  onClose?: (ev: CloseEvent) => void;
  onError?: (ev: Event) => void;
  onParseError?: (raw: string, err: unknown) => void;
}

export interface TranscriptWsClient {
  send: (msg: ClientWsMessage) => void;
  close: () => void;
  readonly readyState: WsReadyState;
}

function mapReadyState(state: number): WsReadyState {
  switch (state) {
    case WebSocket.CONNECTING:
      return "connecting";
    case WebSocket.OPEN:
      return "open";
    case WebSocket.CLOSING:
      return "closing";
    default:
      return "closed";
  }
}

/**
 * Open the /transcript/ws/{sessionId} WebSocket, immediately sending a
 * client_hello on connect. No reconnection logic — FR-1.10 will add
 * exponential backoff in a follow-up slice.
 */
export function connectTranscriptWs(
  sessionId: string,
  handlers: TranscriptWsHandlers,
): TranscriptWsClient {
  const url = `${BACKEND_WS_URL}/transcript/ws/${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    const hello: ClientWsMessage = {
      type: "client_hello",
      sessionId,
      clientVersion: CLIENT_VERSION,
      capabilities: {
        audioFormat: "pcm16le-mono-16khz",
        sendsBinaryAudio: false,
      },
    };
    ws.send(JSON.stringify(hello));
    handlers.onOpen?.();
  });

  ws.addEventListener("message", (ev) => {
    const raw = typeof ev.data === "string" ? ev.data : "";
    try {
      const parsed = JSON.parse(raw) as ServerWsMessage;
      handlers.onMessage(parsed);
    } catch (err) {
      handlers.onParseError?.(raw, err);
    }
  });

  ws.addEventListener("close", (ev) => handlers.onClose?.(ev));
  ws.addEventListener("error", (ev) => handlers.onError?.(ev));

  return {
    send(msg: ClientWsMessage) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.send(JSON.stringify({ type: "client_bye", sessionId } satisfies ClientWsMessage));
        } catch {
          // best-effort; underlying socket may already be closing
        }
        ws.close();
      }
    },
    get readyState(): WsReadyState {
      return mapReadyState(ws.readyState);
    },
  };
}
