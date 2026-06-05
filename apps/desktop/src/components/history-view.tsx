import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, History as HistoryIcon, Mic, Users } from "lucide-react";
import type { Meeting, MeetingFilters } from "@meeting-intelligence/shared-types";

import { HistoryFilters } from "@/components/history-filters";
import { SearchInput, type SearchInputHandle } from "@/components/search-input";
import { SearchResults } from "@/components/search-results";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useMeetingsList } from "@/hooks/use-meetings-list";
import { useSearch } from "@/hooks/use-search";
import { formatRelativeDate } from "@/lib/format-date";
import { formatDuration } from "@/lib/format-duration";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";

/**
 * Past-meetings list. Pulls from React Query (`useMeetingsList`) and
 * lets the user dive into a single meeting (`openMeeting`) or return
 * to the recording surface (`goRecording`).
 *
 * Phase 4 additions:
 *   - Search input above the list. Non-empty query swaps the list for
 *     `<SearchResults />` (US-22 / FR-4.03).
 *   - Filter toolbar (`<HistoryFilters />`) fed from already-loaded
 *     meetings. Filters compose with both list mode and search mode
 *     (US-23 / FR-4.05).
 *
 * Style intentionally mirrors `transcript-panel.tsx` and
 * `session-ended-view.tsx` — same Card frame, same display font,
 * same semantic tokens — so the design system stays coherent (CLAUDE.md
 * "Design system continuity").
 */
export function HistoryView() {
  const goRecording = useUiStore((s) => s.goRecording);
  const openMeeting = useUiStore((s) => s.openMeeting);
  const searchFocusPending = useUiStore((s) => s.searchFocusPending);
  const consumeSearchFocus = useUiStore((s) => s.consumeSearchFocus);

  const [filters, setFilters] = useState<MeetingFilters>({});
  const [query, setQuery] = useState("");
  const searchRef = useRef<SearchInputHandle>(null);

  // US-28 ⌘/Ctrl+F: the shortcut handler stages a focus request in the
  // ui-store; consume it here so a normal History open doesn't steal
  // focus. Runs after mount, so a request that also navigated here from
  // another view lands on the freshly-mounted input.
  useEffect(() => {
    if (!searchFocusPending) return;
    searchRef.current?.focus();
    consumeSearchFocus();
  }, [searchFocusPending, consumeSearchFocus]);

  const listQuery = useMeetingsList(filters);
  const searchQuery = useSearch(query, filters);

  const meetings: Meeting[] = useMemo(
    () => listQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [listQuery.data],
  );

  const isSearching = query.trim().length > 0;

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to record"
            onClick={goRecording}
          >
            <ArrowLeft />
          </Button>
          <h2 className="font-display text-xl font-normal tracking-tight">Meetings</h2>
        </div>
        {!isSearching && meetings.length > 0 ? (
          <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
            {meetings.length} {meetings.length === 1 ? "meeting" : "meetings"}
          </span>
        ) : null}
      </header>

      <div className="flex flex-col gap-2 px-6 pt-3">
        <SearchInput ref={searchRef} value={query} onSubmit={setQuery} />
      </div>

      <HistoryFilters filters={filters} onChange={setFilters} meetings={meetings} />

      <CardContent className="flex flex-1 min-h-0 flex-col overflow-hidden p-0">
        {isSearching ? (
          <SearchResults
            hits={searchQuery.data?.items ?? []}
            query={query}
            isPending={searchQuery.isPending || searchQuery.isFetching}
            isError={searchQuery.isError}
            onOpen={(meetingId, segmentStartMs) =>
              openMeeting(meetingId, { initialSegmentStartMs: segmentStartMs })
            }
            onRetry={() => searchQuery.refetch()}
          />
        ) : listQuery.isPending ? (
          <ListSkeleton />
        ) : listQuery.isError ? (
          <ErrorView onRetry={() => listQuery.refetch()} />
        ) : meetings.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <ScrollArea className="flex-1">
              <ol className="flex flex-col">
                {meetings.map((m) => (
                  <li key={m.id}>
                    <MeetingRow meeting={m} onOpen={() => openMeeting(m.id)} />
                  </li>
                ))}
              </ol>
            </ScrollArea>
            {listQuery.hasNextPage ? (
              <div className="flex items-center justify-center border-t px-6 py-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={listQuery.isFetchingNextPage}
                  onClick={() => listQuery.fetchNextPage()}
                >
                  {listQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MeetingRow({ meeting, onOpen }: { meeting: Meeting; onOpen: () => void }) {
  const title = meeting.title?.trim() || "Untitled meeting";
  const duration =
    meeting.durationSeconds != null ? formatDuration(meeting.durationSeconds * 1000) : "—";
  const speakerCount = meeting.speakerCount ?? 0;
  const status = meeting.status;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full items-start gap-4 border-b px-6 py-4 text-left transition-colors",
        "hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
      )}
    >
      <div className="flex flex-1 flex-col gap-1.5 min-w-0">
        <div className="flex items-baseline gap-2">
          <h3 className="truncate font-display text-base font-normal tracking-tight text-foreground">
            {title}
          </h3>
          {status !== "completed" ? (
            <Badge variant="outline" className="shrink-0 text-[10px] uppercase tracking-wide">
              {status}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{formatRelativeDate(meeting.startedAt)}</span>
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
    </button>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-2 border-b px-6 py-4">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  const goRecording = useUiStore((s) => s.goRecording);
  return (
    <Empty className="m-6 flex-1 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HistoryIcon />
        </EmptyMedia>
        <EmptyTitle className="font-display text-xl font-normal">No meetings yet</EmptyTitle>
        <EmptyDescription>
          Your recorded meetings will appear here once you finish a session.
        </EmptyDescription>
      </EmptyHeader>
      <Button type="button" onClick={goRecording}>
        <Mic data-icon="inline-start" className="size-4" />
        Start recording
      </Button>
    </Empty>
  );
}

function ErrorView({ onRetry }: { onRetry: () => void }) {
  return (
    <Empty className="m-6 flex-1 border">
      <EmptyHeader>
        <EmptyTitle className="font-display text-xl font-normal">
          Couldn&apos;t load meetings
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
