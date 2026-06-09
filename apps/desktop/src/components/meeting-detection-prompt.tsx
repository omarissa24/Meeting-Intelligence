import { BellOff, Clock, MoreHorizontal, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { detectionSuppress } from "@/lib/tauri-commands";
import { useDetectionStore } from "@/stores/detection-store";
import { useRecordingStore } from "@/stores/recording-store";

/**
 * Phase 6: non-modal banner that surfaces when the detector thinks the user has
 * joined a meeting. Accepting runs the real recording-start flow (passed in as
 * `onStart` — the same `start` AppShell hands to RecordControl), so the
 * permission gate, meeting provisioning, and WS wiring all come for free.
 *
 * Renders only while a meeting is `active` AND the recorder is idle. A banner
 * (not a Dialog) keeps focus where it is — the user is mid-call in another app.
 */
export function MeetingDetectionPrompt({ onStart }: { onStart: () => void }) {
  const active = useDetectionStore((s) => s.active);
  const dismiss = useDetectionStore((s) => s.dismiss);
  const phase = useRecordingStore((s) => s.phase);

  if (!active || phase !== "idle") return null;

  const { appId, displayName, isBrowserHeuristic } = active;

  const handleStart = () => {
    dismiss();
    onStart();
  };

  const handleSnooze = () => {
    // Snooze every prompt for an hour (3600 s).
    void detectionSuppress(appId, 3600);
    dismiss();
  };

  const handleNever = () => {
    // Permanently silence this app for the session.
    void detectionSuppress(appId);
    dismiss();
  };

  const headline = isBrowserHeuristic ? "Looks like you're in a call" : `${displayName} detected`;
  const sub = isBrowserHeuristic
    ? "We noticed a call in your browser. Start recording?"
    : "Start recording this meeting?";

  return (
    <div className="pointer-events-none fixed inset-x-0 top-20 z-50 flex justify-center px-8">
      <div className="elevation-card pointer-events-auto flex w-full max-w-md animate-rise-in items-center gap-4 rounded-xl border border-border bg-card px-5 py-4">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-selected text-accent"
        >
          <Video className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm font-medium text-foreground">{headline}</p>
          <p className="text-xs text-muted-foreground">{sub}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" size="sm" onClick={handleStart}>
            Start recording
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
            Dismiss
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="More options">
                <MoreHorizontal />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="flex w-56 flex-col gap-0.5 p-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="justify-start gap-2"
                onClick={handleSnooze}
              >
                <Clock className="size-3.5" />
                Snooze for 1 hour
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="justify-start gap-2"
                onClick={handleNever}
              >
                <BellOff className="size-3.5" />
                Never for {displayName}
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}
