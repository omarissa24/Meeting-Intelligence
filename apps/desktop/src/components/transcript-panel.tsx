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
import { cn } from "@/lib/utils";
import { useTranscriptStore } from "@/stores/transcript-store";

const SPEAKER_LABELS: Record<string, string> = {
  "spk-1": "Speaker 1",
  "spk-2": "Speaker 2",
  probe: "Probe",
};

function speakerLabel(id: string): string {
  return SPEAKER_LABELS[id] ?? id;
}

export function TranscriptPanel() {
  const lines = useTranscriptStore((s) => s.lines);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the latest line whenever the count changes.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const viewport = node.querySelector('[data-slot="scroll-area-viewport"]');
    if (viewport instanceof HTMLElement) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [lines.length]);

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle className="font-display text-xl font-normal tracking-tight">
          Live transcript
        </CardTitle>
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
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CaptionsOff />
        </EmptyMedia>
        <EmptyTitle className="font-display text-xl font-normal">Nothing said yet</EmptyTitle>
        <EmptyDescription>
          Press record to start a session. Live transcript appears here as the meeting unfolds.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
