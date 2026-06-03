import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, Users, X } from "lucide-react";
import type { TranscriptSegment } from "@meeting-intelligence/shared-types";

import { MeetingAudioPlayer, type AudioState } from "@/components/meeting-audio-player";
import { MeetingSummary } from "@/components/meeting-summary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useMeetingDetail } from "@/hooks/use-meeting-detail";
import { usePatchActionItem } from "@/hooks/use-patch-action-item";
import { useSummariseMeeting } from "@/hooks/use-summarise-meeting";
import { useUpdateMeeting } from "@/hooks/use-update-meeting";
import { formatRelativeDate } from "@/lib/format-date";
import { formatDuration } from "@/lib/format-duration";
import { speakerLabel } from "@/lib/speaker-label";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";

// Audio archive lifecycle (US-11): once a meeting transitions to
// `completed`, the Celery task encodes the WAV → MP3 and writes
// `audio_object_key`. We poll the detail every 5 s while we're still
// waiting, and give up after 2 min so the player surfaces a clear
// "couldn't be archived" message instead of spinning forever if the
// worker died.
const AUDIO_POLL_INTERVAL_MS = 5_000;
const AUDIO_POLL_BUDGET_MS = 120_000;

interface MeetingDetailViewProps {
  meetingId: string;
}

// Mirrored from `backend/src/meeting_intelligence/api/meetings.py`. The
// backend dedupes / strips whitespace too — we validate up-front so
// the user gets inline feedback before a round-trip.
const MAX_TITLE_LENGTH = 200;
const MAX_TAG_LENGTH = 32;
const MAX_TAGS = 10;

const FALLBACK_TITLE = "Untitled meeting";

/**
 * Read-mostly meeting detail. Title and tags are inline-editable
 * (US-12); the transcript itself stays read-only. Edits commit on
 * blur / Enter via `useUpdateMeeting`, which invalidates both the
 * list and detail caches so the History row re-renders the moment
 * the user navigates back.
 */
export function MeetingDetailView({ meetingId }: MeetingDetailViewProps) {
  const goHistory = useUiStore((s) => s.goHistory);

  // Encode-pending budget: pinned to the first time we observed
  // `completed && audioObjectKey === null`, so the 2 min cap doesn't
  // reset on every refetch. Reset when the meeting id changes —
  // navigating between meetings should re-evaluate from scratch.
  const encodeStartRef = useRef<{ id: string; at: number } | null>(null);
  const [encodeFailed, setEncodeFailed] = useState(false);

  // True once we've observed `audioObjectKey` non-null for this mount
  // — distinguishes "key just got nulled by DELETE" from "encode never
  // produced a key yet". Without this, deleting an archive snaps the
  // UI back to the Preparing skeleton because the parent can't tell
  // those two states apart from the meeting row alone.
  const sawAudioKeyRef = useRef(false);

  // The polling decision is fed back into `useMeetingDetail` from a
  // separate render: we observe the current `data`, set a state flag,
  // and React Query picks up the new `refetchInterval` on the next
  // render. Two-phase loop is fine because each transition is a
  // monotonic step (off → on once, then on → off once the encode
  // lands or the budget elapses).
  const [pollEnabled, setPollEnabled] = useState(false);
  const query = useMeetingDetail(meetingId, {
    refetchIntervalMs: pollEnabled ? AUDIO_POLL_INTERVAL_MS : false,
  });
  const m = query.data;

  // Cold-start gate: a meeting that ended >2 min ago with no audio key
  // is no longer encoding (worker would've finished by now). Without
  // this, opening an old meeting where the audio was previously
  // deleted would trigger a fresh 2-min poll loop on every visit.
  const endedRecently =
    m?.endedAt != null &&
    Date.now() - new Date(m.endedAt).getTime() < AUDIO_POLL_BUDGET_MS;

  // Track whether we've ever seen an archived key during this mount.
  // Survives across `query.data` identity changes (refetches) but
  // resets when the user navigates to a different meeting.
  if (m?.audioObjectKey) {
    sawAudioKeyRef.current = true;
  }

  // Audio state machine — derived once, passed to the player. The
  // player no longer guesses based on `audioObjectKey` alone.
  //
  // The four no-key branches are deliberately distinct:
  //   - `deleted`: in-mount evidence that the key flipped non-null → null
  //   - `failed-encode`: in-mount evidence that the encode budget elapsed
  //   - `no-archive`: cold-start with no in-mount evidence either way —
  //     could be a previous-session delete, a previous-session failure,
  //     or a meeting that ended while the worker was offline. Copy is
  //     deliberately neutral about cause.
  //   - `pending`: meeting completed recently, encode is plausibly still
  //     running (within the 2 min budget).
  const audioState: AudioState = !m
    ? "loading"
    : m.status === "recording" || m.status === "pending"
      ? "hidden"
      : m.status === "failed"
        ? "unavailable"
        : m.audioObjectKey
          ? "ready"
          : sawAudioKeyRef.current
            ? "deleted"
            : encodeFailed
              ? "failed-encode"
              : !endedRecently
                ? "no-archive"
                : "pending";

  const isPendingEncode = audioState === "pending";
  // Phase 3: poll while the LangGraph pipeline is still working too.
  // The same 5s/120s budget covers both — summary completion and
  // audio archive ride the same useMeetingDetail query.
  const isPendingSummary =
    m?.summaryStatus === "pending" || m?.summaryStatus === "processing";
  const shouldPoll = isPendingEncode || isPendingSummary;

  useEffect(() => {
    setPollEnabled(shouldPoll);
  }, [shouldPoll]);

  // Reset the encode-pending tracking when navigating between meetings.
  useEffect(() => {
    encodeStartRef.current = null;
    sawAudioKeyRef.current = false;
    setEncodeFailed(false);
  }, [meetingId]);

  // Stamp the first time we see the encode-pending state and trip the
  // failure flag once the budget elapses. Effect (not render) so we
  // don't loop on the state update.
  useEffect(() => {
    if (!isPendingEncode) {
      encodeStartRef.current = null;
      return;
    }
    const now = Date.now();
    if (
      encodeStartRef.current === null ||
      encodeStartRef.current.id !== meetingId
    ) {
      encodeStartRef.current = { id: meetingId, at: now };
    }
    const elapsed = now - encodeStartRef.current.at;
    if (elapsed >= AUDIO_POLL_BUDGET_MS) {
      setEncodeFailed(true);
      return;
    }
    const remaining = AUDIO_POLL_BUDGET_MS - elapsed;
    const timer = window.setTimeout(() => setEncodeFailed(true), remaining);
    return () => window.clearTimeout(timer);
  }, [isPendingEncode, meetingId]);

  const update = useUpdateMeeting(meetingId);
  const summarise = useSummariseMeeting(meetingId);
  const patchActionItem = usePatchActionItem(meetingId);

  const headerMeta = useMemo(() => {
    if (!query.data) return null;
    const m = query.data;
    return {
      title: m.title,
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
          <div className="min-w-0 flex-1">
            {headerMeta ? (
              <EditableTitle
                key={`${meetingId}:${headerMeta.title ?? ""}`}
                value={headerMeta.title}
                onCommit={(next) => {
                  // Empty trimmed string is a no-op — see plan note on
                  // null vs "" disambiguation. We also skip the PATCH
                  // when the value didn't actually change so blur on
                  // an unedited title isn't a wasted round-trip.
                  if ((next ?? "") === (headerMeta.title ?? "")) return;
                  update.mutate({ title: next });
                }}
              />
            ) : (
              <h2 className="truncate font-display text-xl font-normal tracking-tight text-muted-foreground">
                Loading…
              </h2>
            )}
          </div>
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
        {headerMeta ? (
          <EditableTagList
            tags={headerMeta.tags}
            onCommit={(nextTags) => update.mutate({ tags: nextTags })}
          />
        ) : null}
      </header>

      {query.data ? (
        <MeetingAudioPlayer meeting={query.data} state={audioState} />
      ) : null}

      {query.data ? (
        <div className="border-b px-6 py-4">
          <MeetingSummary
            meetingId={meetingId}
            summary={query.data.summary}
            status={query.data.summaryStatus}
            onRegenerate={() => summarise.mutate()}
            isRegenerating={summarise.isPending}
            onPatchActionItem={(itemId, body) =>
              patchActionItem.mutate({ itemId, body })
            }
          />
        </div>
      ) : null}

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

/**
 * Inline-editable title. Reads as a quiet `<h2>` until the user
 * focuses it; then it swaps to an `<Input>` styled to match. Enter or
 * blur commits via `onCommit`; Escape reverts. We block commits over
 * the 200-char ceiling and surface the count via a `FieldError`.
 */
function EditableTitle({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (next: string | null) => void;
}) {
  const initial = value ?? "";
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState(false);

  // Keep the draft in sync if the underlying value changes (e.g. a
  // refetch after another tab edited the title).
  useEffect(() => {
    if (!editing) setDraft(initial);
  }, [initial, editing]);

  const tooLong = draft.length > MAX_TITLE_LENGTH;
  const display = (value ?? "").trim() || FALLBACK_TITLE;
  const isFallback = !(value ?? "").trim();

  const beginEdit = () => {
    setDraft(value ?? "");
    setEditing(true);
  };

  const commit = () => {
    if (tooLong) return;
    const trimmed = draft.trim();
    setEditing(false);
    if (!trimmed) {
      // Treat empty-trimmed as "revert to current value" — see plan
      // note: an empty PATCH would write "" into the column rather
      // than null, and we don't want that ambiguity.
      setDraft(value ?? "");
      return;
    }
    onCommit(trimmed);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(value ?? "");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={beginEdit}
        className={cn(
          "block w-full max-w-full truncate rounded-md text-left",
          "font-display text-xl font-normal tracking-tight",
          "px-1 py-0.5 -mx-1",
          "transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
          isFallback ? "text-muted-foreground" : "text-foreground",
        )}
        aria-label="Edit meeting title"
      >
        {display}
      </button>
    );
  }

  return (
    <Field>
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={onKeyDown}
        aria-label="Meeting title"
        aria-invalid={tooLong || undefined}
        className={cn("h-9 font-display text-xl font-normal tracking-tight", "bg-transparent")}
        maxLength={MAX_TITLE_LENGTH + 50}
      />
      {tooLong ? (
        <FieldError>
          {`Title must be ${MAX_TITLE_LENGTH} characters or fewer (currently ${draft.length}).`}
        </FieldError>
      ) : null}
    </Field>
  );
}

/**
 * Removable tag chips + a small `<Input>` for adding a new tag via
 * Enter or comma. Validation mirrors the backend's `_validate_tags`:
 * trim, dedupe silently, refuse >32 chars and >10 total. The input
 * stays in the row so the editor is always present, even when the
 * tag list is empty.
 */
function EditableTagList({
  tags,
  onCommit,
}: {
  tags: string[];
  onCommit: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trimmed = draft.trim();
  const wouldExceedTotal = tags.length >= MAX_TAGS;
  const tooLong = trimmed.length > MAX_TAG_LENGTH;

  const tryAdd = () => {
    if (!trimmed) {
      setError(null);
      return;
    }
    if (tooLong) {
      setError(`Tags must be ${MAX_TAG_LENGTH} characters or fewer.`);
      return;
    }
    if (wouldExceedTotal) {
      setError(`A meeting can have at most ${MAX_TAGS} tags.`);
      return;
    }
    if (tags.includes(trimmed)) {
      // Silent dedupe — the backend does the same; surfacing an error
      // here would be noise for the common "I forgot I already added
      // it" case.
      setDraft("");
      setError(null);
      return;
    }
    onCommit([...tags, trimmed]);
    setDraft("");
    setError(null);
  };

  const remove = (tag: string) => {
    onCommit(tags.filter((t) => t !== tag));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      tryAdd();
    } else if (e.key === "Backspace" && !draft && tags.length > 0) {
      // Backspace on an empty input pulls the last chip out for
      // editing — same affordance as Linear / GitHub Issues.
      const last = tags[tags.length - 1];
      onCommit(tags.slice(0, -1));
      setDraft(last);
    } else if (error) {
      // Clear stale validation state once the user starts typing again.
      setError(null);
    }
  };

  return (
    <Field>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="font-normal pr-0.5">
            <span>{tag}</span>
            <button
              type="button"
              onClick={() => remove(tag)}
              aria-label={`Remove tag ${tag}`}
              className={cn(
                "ml-1 inline-flex size-4 items-center justify-center rounded-full",
                "text-muted-foreground transition-colors",
                "hover:bg-foreground/10 hover:text-foreground",
                "focus-visible:bg-foreground/10 focus-visible:text-foreground focus-visible:outline-none",
              )}
            >
              <X className="size-3" aria-hidden />
            </button>
          </Badge>
        ))}
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={tryAdd}
          placeholder={tags.length === 0 ? "Add tag…" : "Add another…"}
          aria-label="Add tag"
          aria-invalid={error != null || undefined}
          className="h-7 w-32 text-sm"
          maxLength={MAX_TAG_LENGTH + 16}
        />
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
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
