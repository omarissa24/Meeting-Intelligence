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

/**
 * Per-second process telemetry from the Rust perf-monitor thread.
 * Mirrors `recording::PerfStatsPayload` (camelCase via serde).
 *
 * `cpuPercent` is normalised to a 0..=100 scale on the Rust side
 * (sysinfo's per-core sum is divided by `available_parallelism`), so
 * the value is directly comparable to the US-07 ≤8% target.
 *
 * Subscribers are typically a debug overlay or a stability harness;
 * production UI doesn't have to render this.
 */
export interface PerfStatsPayload {
  sessionId: string;
  cpuPercent: number;
  rssMb: number;
  uptimeMs: number;
}

/**
 * Per-tick mic level from the Rust level-emitter thread (US-25a).
 * Mirrors `recording::MicLevelPayload` (camelCase via serde). Emitted
 * ~10 Hz while recording.
 *
 * Both values are dBFS with a -120.0 floor for silence. `micRawDbfs`
 * is the device-side peak **before** the static gain factor;
 * `micResampledDbfs` is the post-gain, post-resample peak — i.e. what
 * the encoder/STT actually consumes. The meter shows both so the user
 * can see whether their input is healthy independent of the gain
 * compensation.
 */
export interface MicLevelPayload {
  sessionId: string;
  micRawDbfs: number;
  micResampledDbfs: number;
}

const EVENT_AUDIO_CHUNK = "audio://chunk";
const EVENT_AUDIO_ERROR = "audio://error";
const EVENT_PERF_STATS = "perf://stats";
const EVENT_MIC_LEVEL = "audio://level";

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

/**
 * Subscribe to `perf://stats` for the lifetime of a session. Filters
 * by `sessionId` for symmetry with the chunk/error subscribers — a
 * stale listener from a prior session doesn't bleed values into the
 * current one.
 */
export async function subscribePerfStats(
  sessionId: string,
  onStats: (payload: PerfStatsPayload) => void,
): Promise<UnlistenFn> {
  return listen<PerfStatsPayload>(EVENT_PERF_STATS, (event) => {
    if (event.payload.sessionId !== sessionId) return;
    onStats(event.payload);
  });
}

/**
 * Subscribe to `audio://level` for the lifetime of a session. Fires
 * ~10 Hz with the latest mic peaks (raw + resampled) in dBFS. Filters
 * by `sessionId` so a stale listener from a prior session doesn't bleed
 * levels into the current one. Returned unlisten function is called on
 * stop or component unmount.
 */
export async function subscribeMicLevel(
  sessionId: string,
  onLevel: (payload: MicLevelPayload) => void,
): Promise<UnlistenFn> {
  return listen<MicLevelPayload>(EVENT_MIC_LEVEL, (event) => {
    if (event.payload.sessionId !== sessionId) return;
    onLevel(event.payload);
  });
}
