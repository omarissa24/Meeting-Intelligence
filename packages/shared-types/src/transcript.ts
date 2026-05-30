/**
 * Placeholder transcript types.
 *
 * These are mirrored by hand from Pydantic models in `backend/`. Real shapes
 * land in Phase 1 when the WS payload contract is implemented.
 */

export interface Speaker {
  id: string;
  label: string;
}

export interface TranscriptLine {
  sessionId: string;
  speakerId: string;
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

export interface RecordingSession {
  id: string;
  startedAt: string;
  endedAt: string | null;
}
