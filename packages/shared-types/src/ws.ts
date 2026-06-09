import type { TranscriptLine } from "./transcript";

/**
 * Audio format declared by the client in `client_hello`. Locked early so future
 * audio-capable clients don't renegotiate the protocol — the desktop app will
 * always send 16 kHz mono PCM little-endian once native capture lands.
 */
export type ClientAudioFormat = "pcm16le-mono-16khz";

export interface ClientCapabilities {
  audioFormat: ClientAudioFormat;
  /** False until the audio-capture slice lands; backend then routes through real STT. */
  sendsBinaryAudio: boolean;
}

export interface ClientHello {
  type: "client_hello";
  sessionId: string;
  clientVersion: string;
  capabilities: ClientCapabilities;
  /**
   * Optional BCP-47 short code (e.g. "en", "es", "fr") or "auto". When
   * absent or "auto", the backend lets the STT provider auto-detect.
   * Older clients omit this field; backend treats absence as "auto".
   */
  language?: string;
}

export interface ClientBye {
  type: "client_bye";
  sessionId: string;
}

/**
 * Shape locked for the audio-capture slice. Not sent in the foundation slice;
 * defined here so the audio-capture plan doesn't need to renegotiate.
 */
export interface ClientAudioChunk {
  type: "audio_chunk";
  sessionId: string;
  seq: number;
  pcmBase64: string;
}

/**
 * Foundation-slice drive frame: any text the client wants to see echoed back
 * as a final transcript line. Useful for manual smoke tests; future slices
 * may remove or repurpose it.
 */
export interface ClientTextProbe {
  type: "text_probe";
  sessionId: string;
  text: string;
}

export type ClientWsMessage = ClientHello | ClientBye | ClientAudioChunk | ClientTextProbe;

export interface SessionStarted {
  type: "session_started";
  sessionId: string;
  startedAt: string;
  /** Identifier of the active STT implementation, e.g. "in-memory-echo" or "deepgram-nova-3". */
  sttProvider: string;
}

export interface TranscriptLineMsg {
  type: "transcript_line";
  line: TranscriptLine;
}

export interface SessionEndedStats {
  durationMs: number;
  finalLineCount: number;
}

export interface SessionEnded {
  type: "session_ended";
  sessionId: string;
  endedAt: string;
  stats: SessionEndedStats;
}

export interface ServerError {
  type: "error";
  code: string;
  message: string;
  recoverable: boolean;
}

export type ServerWsMessage = SessionStarted | TranscriptLineMsg | SessionEnded | ServerError;

export type ClientMessageType = ClientWsMessage["type"];
export type ServerMessageType = ServerWsMessage["type"];
