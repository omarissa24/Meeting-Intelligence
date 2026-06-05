import { useMemo } from "react";
import { SearchX } from "lucide-react";
import type { SearchHit } from "@meeting-intelligence/shared-types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration } from "@/lib/format-duration";
import { formatRelativeDate, formatTime } from "@/lib/format-date";
import { cn } from "@/lib/utils";

/**
 * Phase 4 / US-22 search results panel. Renders a list of ranked
 * `SearchHit` rows; clicking one opens the meeting detail view and
 * scrolls the transcript to the segment via `pendingSegmentStartMs`
 * on the ui-store.
 */
export interface SearchResultsProps {
  hits: SearchHit[];
  query: string;
  isPending: boolean;
  isError: boolean;
  onOpen: (meetingId: string, segmentStartMs: number) => void;
  onRetry?: () => void;
}

export function SearchResults({
  hits,
  query,
  isPending,
  isError,
  onOpen,
  onRetry,
}: SearchResultsProps) {
  if (isPending) return <ListSkeleton />;
  if (isError) return <ErrorView onRetry={onRetry} />;
  if (hits.length === 0) return <NoResults query={query} />;
  return (
    <ScrollArea type="auto" className="min-h-0 flex-1">
      <ol className="flex flex-col">
        {hits.map((hit) => (
          <li key={hit.segmentId}>
            <SearchHitRow
              hit={hit}
              query={query}
              onOpen={() => onOpen(hit.meetingId, hit.segmentStartMs)}
            />
          </li>
        ))}
      </ol>
    </ScrollArea>
  );
}

function SearchHitRow({
  hit,
  query,
  onOpen,
}: {
  hit: SearchHit;
  query: string;
  onOpen: () => void;
}) {
  const title = hit.meetingTitle?.trim() || "Untitled meeting";
  const segments = useMemo(
    () => highlightMatches(hit.segmentText, query),
    [hit.segmentText, query],
  );
  const timestamp = formatDuration(hit.segmentStartMs);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex w-full flex-col gap-2 border-b px-6 py-4 text-left transition-base",
        "hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="truncate font-display text-base font-normal tracking-tight text-foreground">
          {title}
        </h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatRelativeDate(hit.meetingStartedAt)} · {formatTime(hit.meetingStartedAt)}
        </span>
      </div>
      <div className="flex items-start gap-3">
        <Badge variant="outline" className="mt-0.5 shrink-0 font-normal tabular-nums">
          {timestamp}
        </Badge>
        <p className="text-sm text-muted-foreground line-clamp-3">
          {segments.map((seg, i) =>
            seg.match ? (
              <mark
                key={i}
                className="rounded-[3px] bg-surface-selected px-0.5 font-medium text-foreground"
              >
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </p>
      </div>
    </button>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2 border-b px-6 py-4">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

function NoResults({ query }: { query: string }) {
  return (
    <Empty className="m-6 flex-1 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX />
        </EmptyMedia>
        <EmptyTitle className="text-title">No results for &ldquo;{query}&rdquo;</EmptyTitle>
        <EmptyDescription>Try a different phrase, or clear the filters above.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ErrorView({ onRetry }: { onRetry?: () => void }) {
  return (
    <Empty className="m-6 flex-1 border">
      <EmptyHeader>
        <EmptyTitle className="text-title">Search failed</EmptyTitle>
        <EmptyDescription>
          The backend didn&apos;t respond. Check your connection and try again.
        </EmptyDescription>
      </EmptyHeader>
      {onRetry ? (
        <Button type="button" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </Empty>
  );
}

interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Case-insensitive literal substring highlighter. We intentionally
 * avoid regex: the query is user input and we don't want to add an
 * escape-regex utility in this tight a slice. Semantic matches that
 * don't contain the literal query render plain (the timestamp +
 * card layout already implies the match was relevant).
 */
export function highlightMatches(text: string, query: string): HighlightSegment[] {
  const trimmed = query.trim();
  if (!trimmed) return [{ text, match: false }];
  const haystack = text.toLowerCase();
  const needle = trimmed.toLowerCase();
  if (!haystack.includes(needle)) return [{ text, match: false }];
  const segments: HighlightSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) {
      segments.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) segments.push({ text: text.slice(i, idx), match: false });
    segments.push({
      text: text.slice(idx, idx + trimmed.length),
      match: true,
    });
    i = idx + trimmed.length;
  }
  return segments;
}
