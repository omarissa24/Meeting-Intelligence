import { Mic, Monitor } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface PermissionPromptProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /**
   * Triggered when the user clicks the primary action — invokes the
   * Tauri command that fires both macOS prompts in sequence.
   */
  onRequest: () => void;
  /** Set true while the OS prompts are mid-flight; disables the CTA. */
  pending?: boolean;
}

/**
 * Pre-flight permission explainer. Shown once on the first
 * Record click when the user has never granted mic + screen
 * recording. Both gates need granting before SCKit / cpal can
 * start capturing.
 *
 * The prompt is intentionally non-dismissable-by-overlay (and has
 * no Cancel / Maybe-Later button on the OS prompts themselves) —
 * the only way to start recording is granting access. We do
 * provide a clear "Not now" exit so users can back out without
 * being trapped.
 */
export function PermissionPrompt({
  open,
  onOpenChange,
  onRequest,
  pending = false,
}: PermissionPromptProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-title">Allow Marens to listen</DialogTitle>
          <DialogDescription>
            Two macOS permissions are needed before the first recording. Both prompts will appear
            after you continue.
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-4 py-2">
          <li className="flex items-start gap-3">
            <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
              <Mic className="size-4" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Microphone</p>
              <p className="text-muted-foreground text-sm">
                Captures your voice during the meeting.
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
              <Monitor className="size-4" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Screen &amp; System Audio Recording</p>
              <p className="text-muted-foreground text-sm">
                Captures the meeting&rsquo;s audio (Zoom, Teams, Meet&hellip;). Only the audio is
                read; the screen image is discarded.
              </p>
            </div>
          </li>
        </ul>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Not now
          </Button>
          <Button onClick={onRequest} disabled={pending}>
            {pending ? "Waiting for system prompts…" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
