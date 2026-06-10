import { useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { installStagedUpdate } from "@/lib/updater-bridge";
import { useRecordingStore } from "@/stores/recording-store";
import { useUpdateStore } from "@/stores/update-store";

/**
 * Non-intrusive "Restart to update" strip (US-24). Renders only when a
 * downloaded update is staged AND no recording session is in flight —
 * restarting mid-`recording` would kill the capture, and mid-`stopping`
 * it would race the drain/archive. The banner reappears on its own once
 * the session ends (it's pure derived state).
 */
export function UpdateBanner() {
  const status = useUpdateStore((s) => s.status);
  const version = useUpdateStore((s) => s.version);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const phase = useRecordingStore((s) => s.phase);
  const [installing, setInstalling] = useState(false);

  const sessionBusy = phase === "starting" || phase === "recording" || phase === "stopping";
  if (status !== "ready" || dismissed || sessionBusy) return null;

  const handleInstall = async () => {
    setInstalling(true);
    try {
      await installStagedUpdate();
      // Unreachable on success — the app relaunches.
    } catch (err) {
      setInstalling(false);
      toast.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-8 mb-2 flex animate-rise-in items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm"
    >
      <RefreshCw className="size-4 text-primary" />
      <span className="flex-1 text-foreground">Version {version} is ready to install.</span>
      <Button
        size="sm"
        disabled={installing}
        onClick={() => {
          void handleInstall();
        }}
      >
        {installing ? <Loader2 className="size-4 animate-spin" /> : null}
        Restart to update
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss update notification"
        onClick={dismiss}
      >
        <X />
      </Button>
    </div>
  );
}
