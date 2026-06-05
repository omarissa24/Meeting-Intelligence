import { Mic, Square } from "lucide-react";

import { MicLevelMeter } from "@/components/mic-level-meter";
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
const isBusy = (p: RecordingPhase): boolean =>
  p === "starting" ||
  p === "stopping" ||
  p === "checking-permissions" ||
  p === "requesting-permissions";

export function RecordControl({ phase, elapsedMs, onStart, onStop }: RecordControlProps) {
  const live = isLive(phase);
  const busy = isBusy(phase);

  return (
    <div className="flex items-center gap-6">
      <div className="relative flex items-center justify-center">
        {/* Live: a soft breathing halo behind the button — the one place
            the amber-distinct recording red is allowed to perform. */}
        {live ? (
          <span
            aria-hidden
            className="absolute -inset-2 animate-breathe rounded-full bg-recording-glow blur-md"
          />
        ) : null}
        <Button
          type="button"
          aria-label={live ? "Stop recording" : "Start recording"}
          onClick={live ? onStop : onStart}
          disabled={busy}
          className={cn(
            // Hero sizing — bigger than any default size variant.
            "relative size-16 rounded-full p-0 transition-base hover:scale-[1.04] active:scale-95",
            live
              ? "bg-recording text-primary-foreground shadow-[0_0_0_5px_var(--recording-glow)] hover:bg-recording-hover"
              : "bg-foreground text-background elevation-card hover:bg-foreground/90",
          )}
        >
          {live ? (
            <Square data-icon="inline-start" className="size-5 fill-current" />
          ) : (
            <Mic data-icon="inline-start" className="size-6" />
          )}
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {live ? (
            <span aria-hidden className="size-2 animate-breathe rounded-full bg-recording" />
          ) : null}
          <span className="text-eyebrow">{phaseLabel(phase)}</span>
        </div>
        <span aria-live="polite" className="text-numeral text-4xl leading-none text-foreground">
          {formatElapsed(elapsedMs)}
        </span>
      </div>

      {/* Live input meter — self-gates on the recording phase, so it's
          present at all times but only renders while recording. */}
      <MicLevelMeter />
    </div>
  );
}

function phaseLabel(p: RecordingPhase): string {
  switch (p) {
    case "idle":
      return "Ready";
    case "checking-permissions":
      return "Checking access…";
    case "requesting-permissions":
      return "Awaiting access…";
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
