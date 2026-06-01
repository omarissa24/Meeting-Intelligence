import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Payload of every `audio://chunk` event emitted by the Rust audio
 * pipeline. Mirrors `recording::AudioChunkPayload` (camelCase via
 * `#[serde(rename_all = "camelCase")]`).
 *
 * `pcmBase64` is base64-encoded 16-bit little-endian mono PCM at 16 kHz
 * — the wire format the backend's `audio_chunk` WS frame expects. JS
 * forwards it untouched; no decoding required on this side.
 */
export interface AudioChunkPayload {
  sessionId: string;
  seq: number;
  pcmBase64: string;
  /** Wall-clock duration of the chunk's PCM payload (typically 1000). */
  durationMs: number;
}

/**
 * Capture-side error event. Surfaced when a device disconnects or
 * permissions are revoked mid-session — the recording UI shows this
 * as a toast and (if `recoverable === false`) auto-stops the session.
 */
export interface AudioErrorPayload {
  sessionId: string;
  code: string;
  message: string;
  recoverable: boolean;
}

const EVENT_AUDIO_CHUNK = "audio://chunk";
const EVENT_AUDIO_ERROR = "audio://error";

/**
 * Subscribe to `audio://chunk` events for the duration of a session.
 * `onChunk` fires once per ~1-second PCM payload. Returns an
 * unsubscribe function — call it on session stop or component unmount
 * so the listener doesn't leak across sessions.
 *
 * Filters to chunks belonging to `sessionId` so a stale listener from
 * a previous session can't accidentally interleave events into the
 * new session's WS stream.
 */
export async function subscribeAudioChunks(
  sessionId: string,
  onChunk: (payload: AudioChunkPayload) => void,
): Promise<UnlistenFn> {
  return listen<AudioChunkPayload>(EVENT_AUDIO_CHUNK, (event) => {
    if (event.payload.sessionId !== sessionId) return;
    onChunk(event.payload);
  });
}

/**
 * Subscribe to `audio://error` for the lifetime of a session.
 * Returned unlisten function is called on stop.
 */
export async function subscribeAudioErrors(
  sessionId: string,
  onError: (payload: AudioErrorPayload) => void,
): Promise<UnlistenFn> {
  return listen<AudioErrorPayload>(EVENT_AUDIO_ERROR, (event) => {
    if (event.payload.sessionId !== sessionId) return;
    onError(event.payload);
  });
}
