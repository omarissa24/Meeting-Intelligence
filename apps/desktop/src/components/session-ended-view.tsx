import { useMemo, useState } from "react";
import { Copy, Mic, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useRecording } from "@/hooks/use-recording";
import { formatDuration } from "@/lib/format-duration";
import { speakerLabel } from "@/lib/speaker-label";
import {
  countSpeakers,
  countWords,
  renderTranscriptForClipboard,
} from "@/lib/transcript-stats";
import { cn } from "@/lib/utils";
import { useRecordingStore } from "@/stores/recording-store";
import { SYSTEM_SPEAKER_ID, useTranscriptStore } from "@/stores/transcript-store";

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
export function SessionEndedView() {
  const { start } = useRecording();
  const startedAt = useRecordingStore((s) => s.startedAt);
  const endedAt = useRecordingStore((s) => s.endedAt);
  const durationMs = useRecordingStore((s) => s.durationMs);
  const elapsedMs = useRecordingStore((s) => s.elapsedMs);
  const lines = useTranscriptStore((s) => s.lines);

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

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle className="font-display text-xl font-normal tracking-tight">
          Session ended
        </CardTitle>
        <CardDescription>{formatTimeRange(startedAt, endedAt)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto p-6">
        <div className="shrink-0">
          <StatGrid stats={stats} />
        </div>
        <div className="shrink-0">
          <SummaryPlaceholder />
        </div>
        <div className="shrink-0">
          <ActionRow onStartNew={handleStartNew} onCopy={handleCopy} />
        </div>
        <TranscriptReview lines={lines} />
      </CardContent>
    </Card>
  );
}

function StatGrid({
  stats,
}: {
  stats: { duration: string; words: number; speakers: number };
}) {
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
    <Card size="sm" className="bg-card/60">
      <CardContent className="flex flex-col gap-1 py-1">
        <span className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
        <span className="font-display text-2xl font-normal leading-none tabular-nums tracking-tight">
          {value}
        </span>
      </CardContent>
    </Card>
  );
}

function SummaryPlaceholder() {
  return (
    <div
      className="flex items-start gap-3 rounded-xl border border-dashed border-border px-4 py-3"
      role="note"
    >
      <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Meeting summary</span>
        <span className="text-sm text-muted-foreground">
          Automatic summaries will be available in a future release. The
          transcript above is yours to copy or review now.
        </span>
      </div>
    </div>
  );
}

function ActionRow({
  onStartNew,
  onCopy,
}: {
  onStartNew: () => void;
  onCopy: () => void;
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
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-foreground/80 hover:text-foreground">
        Review transcript ({lines.length} {lines.length === 1 ? "line" : "lines"})
      </summary>
      <ScrollArea className="max-h-72 border-t">
        <ol className="flex flex-col gap-2 px-4 py-3">
          {lines.map((line, idx) => {
            if (line.speakerId === SYSTEM_SPEAKER_ID) {
              return (
                <li key={`${line.sessionId}-${idx}`} className="text-center">
                  <p className="text-xs italic text-muted-foreground/80">
                    — {line.text} —
                  </p>
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
