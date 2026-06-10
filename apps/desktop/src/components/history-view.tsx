import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, History as HistoryIcon, Mic } from "lucide-react";
import type { Meeting, MeetingFilters } from "@meeting-intelligence/shared-types";

import { ActiveFilterChips, HistoryFilters } from "@/components/history-filters";
import { ListSkeleton, MeetingRow } from "@/components/meeting-row";
import { SearchInput, type SearchInputHandle } from "@/components/search-input";
import { SearchResults } from "@/components/search-results";
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
import { useMeetingsList } from "@/hooks/use-meetings-list";
import { useSearch } from "@/hooks/use-search";
import { formatDayKey, formatRelativeDate } from "@/lib/format-date";
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

  // Day groups derive from the flat paginated array every render, so
  // "Load more" extends existing groups / appends new ones for free.
  const dayGroups = useMemo(() => groupByDay(meetings), [meetings]);

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
          <h2 className="text-title">Meetings</h2>
        </div>
        {!isSearching && meetings.length > 0 ? (
          <span className="text-eyebrow">
            {meetings.length} {meetings.length === 1 ? "meeting" : "meetings"}
          </span>
        ) : null}
      </header>

      <div className="flex flex-col gap-2 border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <SearchInput ref={searchRef} className="flex-1" value={query} onSubmit={setQuery} />
          <HistoryFilters filters={filters} onChange={setFilters} meetings={meetings} />
        </div>
        <ActiveFilterChips filters={filters} onChange={setFilters} />
      </div>

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
            <ScrollArea type="auto" className="min-h-0 flex-1">
              {dayGroups.map((group) => (
                <section key={group.key} aria-label={group.label}>
                  {/* Sticky day header — `sticky` makes it positioned, so
                      it paints above the static rows without manual
                      z-index; opaque bg-card stops row bleed-through. */}
                  <h3 className="sticky top-0 border-b bg-card px-6 py-1.5 text-eyebrow">
                    {group.label}
                  </h3>
                  <ol className="flex flex-col">
                    {group.meetings.map((m) => (
                      <li key={m.id}>
                        <MeetingRow meeting={m} onOpen={() => openMeeting(m.id)} />
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
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

interface DayGroup {
  key: string;
  label: string;
  meetings: Meeting[];
}

/**
 * Bucket a server-ordered (newest-first) flat list into per-day groups,
 * preserving order. Meetings without a parseable `startedAt` collect in
 * a trailing "Undated" group rather than crashing the headers.
 */
function groupByDay(meetings: Meeting[]): DayGroup[] {
  const groups: DayGroup[] = [];
  const byKey = new Map<string, DayGroup>();
  const undated: Meeting[] = [];

  for (const m of meetings) {
    const key = formatDayKey(m.startedAt);
    if (!key) {
      undated.push(m);
      continue;
    }
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: formatRelativeDate(m.startedAt), meetings: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.meetings.push(m);
  }

  if (undated.length > 0) {
    groups.push({ key: "undated", label: "Undated", meetings: undated });
  }
  return groups;
}

function EmptyState() {
  const goRecording = useUiStore((s) => s.goRecording);
  return (
    <Empty className="m-6 flex-1 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HistoryIcon />
        </EmptyMedia>
        <EmptyTitle className="text-title">No meetings yet</EmptyTitle>
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
        <EmptyTitle className="text-title">Couldn&apos;t load meetings</EmptyTitle>
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
