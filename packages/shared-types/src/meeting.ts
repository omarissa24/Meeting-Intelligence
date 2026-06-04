/**
 * Meeting DTOs — mirrored from backend Pydantic models in
 * `backend/src/meeting_intelligence/api/meetings.py`.
 *
 * Wire is camelCase. Date-time fields are ISO 8601 UTC strings (the
 * backend emits `…Z`). All UUID fields are strings client-side.
 */

import type { TranscriptLine } from "./transcript";

export type MeetingStatus = "pending" | "recording" | "completed" | "failed";

/**
 * Phase-3 summary lifecycle.
 *
 *   pending    → no row exists yet (mid-recording or just before the
 *                Celery task fires).
 *   processing → row exists, LangGraph pipeline running.
 *   completed  → final structured summary written.
 *   failed     → LLM produced unrecoverable output (validation twice
 *                or tool-use refusal). `error` carries the message.
 *   too_short  → transcript fell below the 50-word floor; no LLM call.
 */
export type SummaryStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "too_short";

/** A single topic discussed during the meeting plus its estimated duration. */
export interface Topic {
  name: string;
  durationSeconds: number;
}

/** One action item — independently editable via PATCH. */
export interface ActionItem {
  id: string;
  description: string;
  /** `null` when no owner was stated; UI renders "Unassigned". */
  owner: string | null;
  /** ISO 8601 date (yyyy-mm-dd) or `null` when no deadline was stated. */
  deadline: string | null;
  completed: boolean;
  /** UTC timestamp set when `completed` flips true; cleared when it flips false. */
  completedAt: string | null;
  /** Stable LLM emission order, preserved across regenerates. */
  orderIndex: number;
}

/**
 * Structured summary payload. `decisions` is a flat list of one-sentence
 * strings; if the meeting had no decisions it's `[]` and the UI renders
 * "No decisions recorded" — never invented content (FR-3.08 guard).
 *
 * `confidenceLow` indicates fewer than 2 distinct speakers were
 * detected; the UI surfaces this as a footnote.
 *
 * Token counts and `modelVersion` are populated for observability;
 * `error` is non-null only when `status === "failed"`.
 */
export interface MeetingSummary {
  status: SummaryStatus;
  summary: string | null;
  decisions: string[];
  topics: Topic[];
  actionItems: ActionItem[];
  confidenceLow: boolean;
  modelVersion: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
  /** First time the summary was generated for this meeting. */
  generatedAt: string | null;
  /** Most recent regenerate, or null when this is the original write. */
  regeneratedAt: string | null;
}

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
  /**
   * Phase-3 structured summary; `null` while the row hasn't been
   * written yet (`summaryStatus === "pending"`). Once the Celery task
   * upserts, this is non-null and `summary.status` matches
   * `summaryStatus`.
   */
  summary: MeetingSummary | null;
  /**
   * Convenience field equal to `summary?.status ?? "pending"`. The
   * desktop polls while this is `"pending"` or `"processing"`.
   */
  summaryStatus: SummaryStatus;
}

/** Body for PATCH /meetings/:id/action_items/:item_id (partial update). */
export interface PatchActionItemRequest {
  description?: string;
  /** Explicit `null` clears the owner; omit to leave unchanged. */
  owner?: string | null;
  /** ISO 8601 date or `null` to clear; omit to leave unchanged. */
  deadline?: string | null;
  completed?: boolean;
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

/**
 * Phase-4 history filters (US-23 / FR-4.05). All fields are optional;
 * `tags` is empty when no tag filter is active. The same shape is used
 * for both the filtered `GET /meetings` listing and `POST /search` so
 * the UI can pass one filter object to both hooks.
 *
 * Date strings are ISO 8601 calendar dates (`YYYY-MM-DD`); the backend
 * treats `dateEnd` as inclusive and converts to `< dateEnd + 1 day`
 * internally.
 */
export interface MeetingFilters {
  dateStart?: string | null;
  dateEnd?: string | null;
  durationMinSeconds?: number | null;
  durationMaxSeconds?: number | null;
  tags?: string[];
}

/**
 * Phase-4 semantic search request body (US-22 / FR-4.03). `limit` is
 * capped at 50 server-side; the desktop sends `10` by default.
 */
export interface SearchRequest extends MeetingFilters {
  query: string;
  limit?: number;
}

/** One ranked hit returned by `POST /search`. `score` is `1 - cosine_distance`. */
export interface SearchHit {
  meetingId: string;
  meetingTitle: string | null;
  meetingStartedAt: string | null;
  segmentId: string;
  segmentText: string;
  segmentStartMs: number;
  segmentEndMs: number;
  speakerId: string | null;
  score: number;
}

export interface SearchResponse {
  items: SearchHit[];
}
