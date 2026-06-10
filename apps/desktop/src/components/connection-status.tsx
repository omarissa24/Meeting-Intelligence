import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection-store";

export function ConnectionStatus() {
  const phase = useConnectionStore((s) => s.phase);

  // Live countdown while reconnecting — only ticks when needed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase.kind !== "reconnecting") return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [phase.kind]);

  // No session → no socket → nothing to report. The old "Offline" label
  // read as an error state while the app was simply idle.
  if (phase.kind === "idle") return null;

  const { dot, label } = (() => {
    switch (phase.kind) {
      case "open":
        return { dot: "bg-accent", label: "Connected" } as const;
      case "connecting":
        return {
          dot: "bg-muted-foreground/60 animate-pulse",
          label: phase.attempt === 0 ? "Connecting" : `Connecting (attempt ${phase.attempt + 1})`,
        } as const;
      case "reconnecting": {
        const remaining = Math.max(0, Math.ceil((phase.nextRetryAtMs - now) / 1000));
        return {
          dot: "bg-accent animate-pulse",
          label: `Reconnecting · attempt ${phase.attempt + 1} · ${remaining}s`,
        } as const;
      }
      case "failed":
      default:
        return { dot: "bg-destructive", label: "Disconnected" } as const;
    }
  })();

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 rounded-full transition-colors", dot)} />
      <span className="tabular-nums">{label}</span>
    </div>
  );
}
