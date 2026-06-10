import { ChevronRight, Users } from "lucide-react";
import type { Meeting, MeetingStatus } from "@meeting-intelligence/shared-types";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeDate, formatTime } from "@/lib/format-date";
import { formatDuration } from "@/lib/format-duration";
import { displayMeetingTitle } from "@/lib/meeting-title";
import { cn } from "@/lib/utils";

/**
 * One meeting row — shared between the history list and the home
 * screen's recent-meetings section so the two can never drift apart.
 * Whole row is a button (`openMeeting`); the trailing chevron fades in
 * on hover/focus to signal clickability without adding permanent noise.
 */
export function MeetingRow({ meeting, onOpen }: { meeting: Meeting; onOpen: () => void }) {
  const { title, isFallback } = displayMeetingTitle(meeting);
  const duration =
    meeting.durationSeconds != null ? formatDuration(meeting.durationSeconds * 1000) : "—";
  const speakerCount = meeting.speakerCount ?? 0;
  const badge = STATUS_BADGES[meeting.status];

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full items-start gap-4 border-b px-6 py-4 text-left transition-base",
        "hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none",
      )}
    >
      <div className="flex flex-1 flex-col gap-1.5 min-w-0">
        <div className="flex items-baseline gap-2">
          <h3
            className={cn(
              "truncate font-display text-base font-normal tracking-tight",
              isFallback ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {title}
          </h3>
          {badge ? (
            <Badge variant={badge.variant} className="shrink-0 text-[10px] uppercase tracking-wide">
              {badge.label}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{formatRelativeDate(meeting.startedAt)}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{formatTime(meeting.startedAt)}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{duration}</span>
          {speakerCount > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                <Users className="size-3" aria-hidden />
                {speakerCount}
              </span>
            </>
          ) : null}
        </div>
        {meeting.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {meeting.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="font-normal">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
      <ChevronRight
        aria-hidden
        className="size-4 shrink-0 self-center text-muted-foreground opacity-0 transition-fast group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  );
}

/**
 * `completed` is the steady state — no badge. The others get a label a
 * human would write ("Processing", not the wire value "pending") and
 * `failed` uses the tinted destructive variant so it reads at a glance.
 */
const STATUS_BADGES: Record<
  MeetingStatus,
  { label: string; variant: "outline" | "destructive" } | null
> = {
  completed: null,
  pending: { label: "Processing", variant: "outline" },
  recording: { label: "Recording", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
};

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 border-b px-6 py-4">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}
