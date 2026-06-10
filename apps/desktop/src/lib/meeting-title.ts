import type { Meeting } from "@meeting-intelligence/shared-types";

export interface DisplayTitle {
  title: string;
  /** True when the title was derived (no user/backend title set). */
  isFallback: boolean;
}

/**
 * Display title for a meeting. The backend default is `NULL`, so untitled
 * meetings used to render as a wall of identical "Untitled meeting" rows.
 * Derive a scannable fallback from the start timestamp instead —
 * "Meeting — Jun 5, 16:01" — via the navigator locale, matching
 * `format-date.ts`. Display-only: editing flows must keep starting from
 * the raw `meeting.title` so the derived text is never committed.
 */
export function displayMeetingTitle(meeting: Pick<Meeting, "title" | "startedAt">): DisplayTitle {
  const trimmed = meeting.title?.trim();
  if (trimmed) return { title: trimmed, isFallback: false };

  if (meeting.startedAt) {
    const d = new Date(meeting.startedAt);
    if (!Number.isNaN(d.getTime())) {
      const stamp = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
      return { title: `Meeting — ${stamp}`, isFallback: true };
    }
  }

  return { title: "Untitled meeting", isFallback: true };
}
