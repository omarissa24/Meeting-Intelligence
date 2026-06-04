import type { ClientWsMessage, ServerWsMessage } from "@meeting-intelligence/shared-types";

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
 * client_hello on connect.
 *
 * `accessToken` is sent in the `Sec-WebSocket-Protocol` header as
 * `bearer.<jwt>` — the FastAPI side at `transcript.py:630-645` parses
 * that subprotocol and binds the user via the same WorkOS JWT path as
 * HTTP routes. Pass `null` only when the user isn't signed in (e.g.
 * legacy callers / tests); the backend in dual-mode will accept the
 * connection anonymously, but production with the DB factory attached
 * closes 1008.
 */
export function connectTranscriptWs(
  sessionId: string,
  handlers: TranscriptWsHandlers,
  accessToken: string | null = null,
  language: string | null = null,
): TranscriptWsClient {
  const url = `${BACKEND_WS_URL}/transcript/ws/${encodeURIComponent(sessionId)}`;
  // Browsers / Tauri's webview only allow tokens via subprotocol on
  // WS upgrade — there's no way to set a custom Authorization header.
  // The backend specifically parses `bearer.<jwt>` for this reason.
  const ws = accessToken
    ? new WebSocket(url, [`bearer.${accessToken}`])
    : new WebSocket(url);

  ws.addEventListener("open", () => {
    const hello: ClientWsMessage = {
      type: "client_hello",
      sessionId,
      clientVersion: CLIENT_VERSION,
      capabilities: {
        audioFormat: "pcm16le-mono-16khz",
        sendsBinaryAudio: false,
      },
      // Older backend builds ignore unknown fields; newer ones (US-25)
      // forward this to STTProvider.transcribe(language=...). Omit
      // when null to keep the wire shape identical to pre-US-25 builds.
      ...(language ? { language } : {}),
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
