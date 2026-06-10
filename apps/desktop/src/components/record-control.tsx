import { Mic, Square } from "lucide-react";

import { MicLevelMeter } from "@/components/mic-level-meter";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { isMacPlatform } from "@/lib/platform";
import { formatShortcut, SHORTCUTS } from "@/lib/shortcuts";
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
  /**
   * `hero` — the home screen's centerpiece: large button, stacked
   * label/timer, keyboard-shortcut hint, no meter (home never records).
   * `compact` — the in-session header row: button + timer + live meter
   * with a stable footprint so nothing jumps when the meter mounts.
   */
  variant?: "hero" | "compact";
}

const isLive = (p: RecordingPhase): boolean => p === "recording" || p === "stopping";
const isBusy = (p: RecordingPhase): boolean =>
  p === "starting" ||
  p === "stopping" ||
  p === "checking-permissions" ||
  p === "requesting-permissions";

export function RecordControl({
  phase,
  elapsedMs,
  onStart,
  onStop,
  variant = "compact",
}: RecordControlProps) {
  const live = isLive(phase);
  const busy = isBusy(phase);
  const hero = variant === "hero";

  const heroButton = (
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
          "relative rounded-full p-0 transition-base hover:scale-[1.04] active:scale-95",
          hero ? "size-20" : "size-16",
          live
            ? "bg-recording text-primary-foreground shadow-[0_0_0_5px_var(--recording-glow)] hover:bg-recording-hover"
            : "bg-foreground text-background elevation-card hover:bg-foreground/90",
        )}
      >
        {/* Icon-only hero button — no `data-icon` here: that attribute
            drives the Button's icon-beside-text padding (`pl-2`), which
            would shove a lone glyph off-center. */}
        {live ? (
          <Square className="size-5 fill-current" />
        ) : (
          <Mic className={hero ? "size-7" : "size-6"} />
        )}
      </Button>
    </div>
  );

  const phaseRow = (
    <div className={cn("flex items-center gap-2", hero && "justify-center")}>
      {live ? (
        <span aria-hidden className="size-2 animate-breathe rounded-full bg-recording" />
      ) : null}
      <span className="text-eyebrow">{phaseLabel(phase)}</span>
    </div>
  );

  const timer = (
    <span
      aria-live="polite"
      className={cn("text-numeral leading-none text-foreground", hero ? "text-5xl" : "text-4xl")}
    >
      {formatElapsed(elapsedMs)}
    </span>
  );

  if (hero) {
    return (
      <div className="flex flex-col items-center gap-4">
        {heroButton}
        <div className="flex flex-col items-center gap-1.5">
          {phaseRow}
          {timer}
        </div>
        <ShortcutHint />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-6">
      {heroButton}
      <div className="flex flex-col gap-1">
        {phaseRow}
        {timer}
      </div>

      {/* Live input meter — self-gates on the recording phase. The
          reserved width keeps the row from reflowing sideways when the
          meter mounts a beat after `starting → recording`. */}
      <div className="flex min-h-10 min-w-[16rem] items-center">
        <MicLevelMeter />
      </div>
    </div>
  );
}

/**
 * "Press ⌘R or click to record" — surfaces the existing US-28 shortcut
 * (see lib/shortcuts.ts) at the moment it's most discoverable.
 */
function ShortcutHint() {
  const startDef = SHORTCUTS.find((s) => s.id === "start-recording");
  if (!startDef) return null;

  return (
    <p className="text-caption flex items-center gap-1.5">
      Press <Kbd>{formatShortcut(startDef, isMacPlatform())}</Kbd> or click to record
    </p>
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
