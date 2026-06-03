/**
 * Meeting DTOs — mirrored from backend Pydantic models in
 * `backend/src/meeting_intelligence/api/meetings.py`.
 *
 * Wire is camelCase. Date-time fields are ISO 8601 UTC strings (the
 * backend emits `…Z`). All UUID fields are strings client-side.
 */

import type { TranscriptLine } from "./transcript";

export type MeetingStatus = "pending" | "recording" | "completed" | "failed";

export interface Meeting {
  id: string;
  title: string | null;
  tags: string[];
  status: MeetingStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  speakerCount: number | null;
  /**
   * Object-storage key (per the configured `ObjectStorageProvider`) for
   * the MP3 archive. `null` while the Celery archive task is in flight,
   * after a failed upload, or after explicit DELETE /meetings/:id/audio.
   * Desktop renders an audio player only when this is non-null.
   */
  audioObjectKey: string | null;
}

/** Persisted transcript segment as returned by GET /meetings/:id. */
export interface TranscriptSegment
  extends Pick<TranscriptLine, "speakerId" | "text" | "startMs" | "endMs" | "isFinal"> {
  id: string;
}

export interface MeetingDetail extends Meeting {
  segments: TranscriptSegment[];
}

export interface MeetingListResponse {
  items: Meeting[];
  /** Opaque base64 cursor; pass back as `?cursor=` to fetch the next page. */
  nextCursor: string | null;
}

export interface CreateMeetingRequest {
  title?: string | null;
  tags?: string[];
}

export interface PatchMeetingRequest {
  title?: string | null;
  tags?: string[];
}

/**
 * Pre-signed URL response for an archived meeting's audio. Mirrored
 * from `MeetingAudioResponse` in `backend/.../api/meetings.py`. URL TTL
 * is bounded by `audio_presigned_url_ttl_seconds` (default 1 h, FR-2.07);
 * `expiresAt` is the wall-clock UTC moment the URL stops working.
 */
export interface MeetingAudioResponse {
  audioUrl: string;
  expiresAt: string;
}
