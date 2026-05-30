import { Mic, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RecordingPhase } from "@/stores/recording-store";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

interface RecordControlProps {
  phase: RecordingPhase;
  elapsedMs: number;
  onStart: () => void;
  onStop: () => void;
}

const isLive = (p: RecordingPhase): boolean => p === "recording" || p === "stopping";
const isBusy = (p: RecordingPhase): boolean => p === "starting" || p === "stopping";

export function RecordControl({ phase, elapsedMs, onStart, onStop }: RecordControlProps) {
  const live = isLive(phase);
  const busy = isBusy(phase);

  return (
    <div className="flex items-center gap-6">
      <Button
        type="button"
        aria-label={live ? "Stop recording" : "Start recording"}
        onClick={live ? onStop : onStart}
        disabled={busy}
        className={cn(
          // Hero sizing — bigger than any default size variant.
          "size-16 rounded-full p-0 transition-shadow",
          live
            ? "bg-[var(--recording)] text-primary-foreground shadow-[0_0_0_6px_var(--recording-glow)] hover:bg-[color-mix(in_oklch,var(--recording),var(--foreground)_8%)]"
            : "bg-foreground text-background hover:bg-foreground/85",
        )}
      >
        {live ? (
          <Square data-icon="inline-start" className="size-5 fill-current" />
        ) : (
          <Mic data-icon="inline-start" className="size-6" />
        )}
      </Button>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {live ? (
            <span
              aria-hidden
              className="size-2 animate-breathe rounded-full bg-[var(--recording)]"
            />
          ) : null}
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {phaseLabel(phase)}
          </span>
        </div>
        <span
          aria-live="polite"
          className="font-display text-4xl leading-none tabular-nums text-foreground"
        >
          {formatElapsed(elapsedMs)}
        </span>
      </div>
    </div>
  );
}

function phaseLabel(p: RecordingPhase): string {
  switch (p) {
    case "idle":
      return "Ready";
    case "starting":
      return "Starting…";
    case "recording":
      return "Recording";
    case "stopping":
      return "Stopping…";
    case "stopped":
      return "Stopped";
  }
}
