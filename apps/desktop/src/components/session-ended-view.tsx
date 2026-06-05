import { useMemo, useState } from "react";
import { ArrowLeft, Copy, History as HistoryIcon, Mic } from "lucide-react";
import { toast } from "sonner";

import { MeetingSummary } from "@/components/meeting-summary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMeetingDetail } from "@/hooks/use-meeting-detail";
import { usePatchActionItem } from "@/hooks/use-patch-action-item";
import { useRecording } from "@/hooks/use-recording";
import { useSummariseMeeting } from "@/hooks/use-summarise-meeting";
import { formatDuration } from "@/lib/format-duration";
import { speakerLabel } from "@/lib/speaker-label";
import { countSpeakers, countWords, renderTranscriptForClipboard } from "@/lib/transcript-stats";
import { cn } from "@/lib/utils";
import { useRecordingStore } from "@/stores/recording-store";
import { SYSTEM_SPEAKER_ID, useTranscriptStore } from "@/stores/transcript-store";
import { useUiStore } from "@/stores/ui-store";

/**
 * Renders right after the user clicks Stop. Mounts on
 * `phase === "stopping" | "stopped"` so the user sees the ended state
 * immediately (optimistic UI) — no waiting on the Rust drain.
 *
 * AC #1 (≤500 ms perceived halt): satisfied by the optimistic mount.
 * AC #2 (transition from live view): the AppShell view-swap.
 * AC #3 (duration / words / speakers): the stat grid.
 * AC #4 (summary processing affordance): honest placeholder; Phase 3
 *       will replace this card with real summary content.
 */
// Phase-3 summary polling: the WS finalize dispatches the Celery
// task; the desktop polls GET /meetings/:id every 3s while the
// summary is still in flight (FR-3.15: ≤45s wall-clock). The 5-min
// cap is a safety net — if the worker died, the user sees a "Retry"
// affordance via the failed-status path inside <MeetingSummary>.
const SUMMARY_POLL_INTERVAL_MS = 3_000;

export function SessionEndedView() {
  const { start } = useRecording();
  const reset = useRecordingStore((s) => s.reset);
  const clearLines = useTranscriptStore((s) => s.clear);
  const goHistory = useUiStore((s) => s.goHistory);
  const startedAt = useRecordingStore((s) => s.startedAt);
  const endedAt = useRecordingStore((s) => s.endedAt);
  const durationMs = useRecordingStore((s) => s.durationMs);
  const elapsedMs = useRecordingStore((s) => s.elapsedMs);
  const sessionId = useRecordingStore((s) => s.sessionId);
  const lines = useTranscriptStore((s) => s.lines);

  // The recording-store sessionId IS the meeting id (the desktop
  // POSTs /meetings before the WS opens; the meeting row's UUID is
  // the WS session_id). Pass it to the summary detail hook so the
  // SessionEnded view sees the same payload the History detail view
  // would see — single source of truth.
  // Skip polling when there's no session yet OR when no transcript
  // landed (the summarise task short-circuits to too_short anyway).
  const shouldPoll = sessionId !== null && lines.length > 0;
  const detailQuery = useMeetingDetail(sessionId, {
    refetchIntervalMs: shouldPoll ? SUMMARY_POLL_INTERVAL_MS : false,
  });
  const summarise = useSummariseMeeting(sessionId ?? "");
  const patchActionItem = usePatchActionItem(sessionId ?? "");

  // While phase === "stopping" the precise durationMs hasn't been
  // written yet (confirmStop runs after the Rust IPC returns). Fall
  // back to the last frozen elapsedMs so the user sees a plausible
  // duration in the same paint as the click.
  const effectiveDuration = durationMs > 0 ? durationMs : elapsedMs;

  const stats = useMemo(
    () => ({
      duration: formatDuration(effectiveDuration),
      words: countWords(lines),
      speakers: countSpeakers(lines),
    }),
    [effectiveDuration, lines],
  );

  const handleCopy = async () => {
    const text = renderTranscriptForClipboard(lines);
    if (!text) {
      toast.message("Nothing to copy", {
        description: "This session didn't capture any transcript lines.",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Transcript copied to clipboard");
    } catch (err) {
      console.error("clipboard write failed", err);
      toast.error("Couldn't copy transcript");
    }
  };

  const handleStartNew = () => {
    void start();
  };

  const handleViewHistory = () => {
    goHistory();
  };

  // Return to the idle home/record screen. AppShell keys the
  // SessionEnded → RecordControl swap on the recording phase, so
  // reset() (→ idle) is what brings the home screen back. Clear the
  // transcript first so home shows its "nothing said yet" empty state
  // rather than the just-ended session's lines.
  const handleGoHome = () => {
    clearLines();
    reset();
  };

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader className="border-b">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to home"
            onClick={handleGoHome}
          >
            <ArrowLeft />
          </Button>
          <div className="flex min-w-0 flex-col gap-0.5">
            <CardTitle className="text-title">Session ended</CardTitle>
            <CardDescription>{formatTimeRange(startedAt, endedAt)}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto p-6">
        <div className="shrink-0">
          <StatGrid stats={stats} />
        </div>
        {sessionId ? (
          <div className="shrink-0">
            <MeetingSummary
              meetingId={sessionId}
              summary={detailQuery.data?.summary ?? null}
              status={detailQuery.data?.summaryStatus ?? "pending"}
              onRegenerate={() => summarise.mutate()}
              isRegenerating={summarise.isPending}
              onPatchActionItem={(itemId, body) => patchActionItem.mutate({ itemId, body })}
            />
          </div>
        ) : null}
        <div className="shrink-0">
          <ActionRow
            onStartNew={handleStartNew}
            onCopy={handleCopy}
            onViewHistory={handleViewHistory}
          />
        </div>
        <TranscriptReview lines={lines} />
      </CardContent>
    </Card>
  );
}

function StatGrid({ stats }: { stats: { duration: string; words: number; speakers: number } }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <StatCard label="Duration" value={stats.duration} />
      <StatCard label="Words" value={stats.words.toLocaleString()} />
      <StatCard label="Speakers" value={stats.speakers.toString()} />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 px-4 py-3">
      <span className="text-eyebrow">{label}</span>
      <span className="text-numeral text-2xl leading-none">{value}</span>
    </div>
  );
}

function ActionRow({
  onStartNew,
  onCopy,
  onViewHistory,
}: {
  onStartNew: () => void;
  onCopy: () => void;
  onViewHistory: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" onClick={onStartNew} size="lg">
        <Mic data-icon="inline-start" className="size-4" />
        Start new recording
      </Button>
      <Button type="button" variant="outline" size="lg" onClick={onCopy}>
        <Copy data-icon="inline-start" className="size-4" />
        Copy transcript
      </Button>
      <Button type="button" variant="outline" size="lg" onClick={onViewHistory}>
        <HistoryIcon data-icon="inline-start" className="size-4" />
        View history
      </Button>
    </div>
  );
}

function TranscriptReview({
  lines,
}: {
  lines: ReturnType<typeof useTranscriptStore.getState>["lines"];
}) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded-xl ring-1 ring-foreground/10"
    >
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-fast hover:text-foreground">
        Review transcript ({lines.length} {lines.length === 1 ? "line" : "lines"})
      </summary>
      <ScrollArea className="max-h-72 border-t">
        <ol className="flex flex-col gap-2 px-4 py-3">
          {lines.map((line, idx) => {
            if (line.speakerId === SYSTEM_SPEAKER_ID) {
              return (
                <li key={`${line.sessionId}-${idx}`} className="text-center">
                  <p className="text-xs italic text-muted-foreground">— {line.text} —</p>
                </li>
              );
            }
            return (
              <li key={`${line.sessionId}-${idx}`} className="flex gap-3">
                <Badge
                  variant="secondary"
                  className="h-fit shrink-0 font-normal tabular-nums tracking-tight"
                >
                  {speakerLabel(line.speakerId)}
                </Badge>
                <p
                  className={cn(
                    "leading-relaxed",
                    line.isFinal ? "text-foreground" : "text-muted-foreground italic",
                  )}
                >
                  {line.text}
                </p>
              </li>
            );
          })}
        </ol>
      </ScrollArea>
    </details>
  );
}

function formatTimeRange(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt);
  const end = endedAt ? new Date(endedAt) : null;
  const fmt = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (!end) return `Started at ${fmt.format(start)}`;
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}
