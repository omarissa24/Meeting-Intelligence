import { useEffect, useRef } from "react";
import { CaptionsOff } from "lucide-react";
import type { TranscriptLine } from "@meeting-intelligence/shared-types";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { speakerLabel } from "@/lib/speaker-label";
import { cn } from "@/lib/utils";
import { useRecordingStore } from "@/stores/recording-store";
import { SYSTEM_SPEAKER_ID, useTranscriptStore } from "@/stores/transcript-store";

// If the user is reading older context, don't snap them back to the
// latest line. 100 px is generous enough that an inertia flick still
// counts as "near the bottom" but tight enough that a deliberate
// scroll-up is preserved.
const AUTOSCROLL_NEAR_BOTTOM_PX = 100;

export function TranscriptPanel() {
  const lines = useTranscriptStore((s) => s.lines);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the latest line — but ONLY when we're already near
  // the bottom. Otherwise the user has scrolled up and we leave them
  // there. (US-02 AC: "transcript panel auto-scrolls to the latest
  // line" interpreted with the obvious sane caveat.)
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const viewport = node.querySelector('[data-slot="scroll-area-viewport"]');
    if (!(viewport instanceof HTMLElement)) return;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom < AUTOSCROLL_NEAR_BOTTOM_PX) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [lines.length]);

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle className="text-title">Live transcript</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        {lines.length === 0 ? (
          <EmptyView />
        ) : (
          <ScrollArea ref={scrollRef} className="h-full">
            <ol className="flex flex-col gap-3 px-6 py-5">
              {lines.map((line, idx) => (
                <TranscriptItem key={`${line.sessionId}-${idx}`} line={line} />
              ))}
            </ol>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function TranscriptItem({ line }: { line: TranscriptLine }) {
  if (line.speakerId === SYSTEM_SPEAKER_ID) {
    return (
      <li role="note" className="animate-line-in flex justify-center py-1">
        <p className="max-w-prose text-center text-xs italic text-muted-foreground">
          — {line.text} —
        </p>
      </li>
    );
  }
  return (
    <li className="animate-line-in flex gap-3">
      <Badge variant="secondary" className="h-fit shrink-0 font-normal tabular-nums tracking-tight">
        {speakerLabel(line.speakerId)}
      </Badge>
      <p
        className={cn(
          "leading-relaxed transition-colors",
          line.isFinal ? "text-foreground" : "text-muted-foreground italic",
        )}
      >
        {line.text}
      </p>
    </li>
  );
}

function EmptyView() {
  const phase = useRecordingStore((s) => s.phase);
  const listening = phase === "starting" || phase === "recording";

  // Mid-session the old copy ("Press record to start a session") was
  // plainly wrong — the user already pressed record. Show a live
  // "Listening…" state instead; the pre-session copy stays as a
  // defensive fallback (the panel no longer mounts on the idle home).
  if (listening) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <span aria-hidden className="size-2 animate-breathe rounded-full bg-recording" />
          </EmptyMedia>
          <EmptyTitle className="text-title">Listening…</EmptyTitle>
          <EmptyDescription>Live transcript appears here as people speak.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CaptionsOff />
        </EmptyMedia>
        <EmptyTitle className="text-title">Nothing said yet</EmptyTitle>
        <EmptyDescription>
          Press record to start a session. Live transcript appears here as the meeting unfolds.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
