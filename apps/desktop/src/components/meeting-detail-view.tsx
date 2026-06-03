import { useMemo } from "react";
import { ArrowLeft, Users } from "lucide-react";
import type { TranscriptSegment } from "@meeting-intelligence/shared-types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useMeetingDetail } from "@/hooks/use-meeting-detail";
import { formatRelativeDate } from "@/lib/format-date";
import { formatDuration } from "@/lib/format-duration";
import { speakerLabel } from "@/lib/speaker-label";
import { useUiStore } from "@/stores/ui-store";

interface MeetingDetailViewProps {
  meetingId: string;
}

/**
 * Read-only meeting detail. Shows persisted (final) segments only —
 * matches the backend `GET /meetings/:id` contract. Editing the title
 * and tags lands with US-12 in a follow-up.
 */
export function MeetingDetailView({ meetingId }: MeetingDetailViewProps) {
  const goHistory = useUiStore((s) => s.goHistory);
  const query = useMeetingDetail(meetingId);

  const headerMeta = useMemo(() => {
    if (!query.data) return null;
    const m = query.data;
    return {
      title: m.title?.trim() || "Untitled meeting",
      date: formatRelativeDate(m.startedAt),
      duration: m.durationSeconds != null ? formatDuration(m.durationSeconds * 1000) : "—",
      speakerCount: m.speakerCount ?? 0,
      tags: m.tags,
    };
  }, [query.data]);

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-col gap-3 border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to meetings"
            onClick={goHistory}
          >
            <ArrowLeft />
          </Button>
          <h2 className="truncate font-display text-xl font-normal tracking-tight">
            {headerMeta?.title ?? "Loading…"}
          </h2>
        </div>
        {headerMeta ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{headerMeta.date}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{headerMeta.duration}</span>
            {headerMeta.speakerCount > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <Users className="size-3" aria-hidden />
                  {headerMeta.speakerCount} {headerMeta.speakerCount === 1 ? "speaker" : "speakers"}
                </span>
              </>
            ) : null}
          </div>
        ) : null}
        {headerMeta && headerMeta.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {headerMeta.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="font-normal">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </header>

      <CardContent className="flex flex-1 min-h-0 flex-col overflow-hidden p-0">
        {query.isPending ? (
          <DetailSkeleton />
        ) : query.isError ? (
          <ErrorView onRetry={() => query.refetch()} />
        ) : query.data && query.data.segments.length === 0 ? (
          <EmptyTranscript />
        ) : query.data ? (
          <ScrollArea className="h-full">
            <ol className="flex flex-col gap-3 px-6 py-5">
              {query.data.segments.map((seg) => (
                <SegmentItem key={seg.id} segment={seg} />
              ))}
            </ol>
          </ScrollArea>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SegmentItem({ segment }: { segment: TranscriptSegment }) {
  return (
    <li className="flex gap-3">
      {segment.speakerId ? (
        <Badge
          variant="secondary"
          className="h-fit shrink-0 font-normal tabular-nums tracking-tight"
        >
          {speakerLabel(segment.speakerId)}
        </Badge>
      ) : null}
      <p className="leading-relaxed text-foreground">{segment.text}</p>
    </li>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-6 py-5">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="h-5 w-16 shrink-0" />
          <Skeleton className="h-5 flex-1" />
        </div>
      ))}
    </div>
  );
}

function EmptyTranscript() {
  return (
    <Empty className="m-6 flex-1 border">
      <EmptyHeader>
        <EmptyTitle className="font-display text-xl font-normal">No transcript</EmptyTitle>
        <EmptyDescription>
          This meeting didn&apos;t produce any final transcript segments.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ErrorView({ onRetry }: { onRetry: () => void }) {
  return (
    <Empty className="m-6 flex-1 border">
      <EmptyHeader>
        <EmptyTitle className="font-display text-xl font-normal">
          Couldn&apos;t load this meeting
        </EmptyTitle>
        <EmptyDescription>
          The backend didn&apos;t respond. Check your connection and try again.
        </EmptyDescription>
      </EmptyHeader>
      <Button type="button" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </Empty>
  );
}
