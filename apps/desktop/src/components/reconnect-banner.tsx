import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection-store";

const RECONNECTED_FLASH_MS = 6_000;

interface ReconnectBannerProps {
  onRetry?: () => void;
}

/**
 * Yellow strip while reconnecting, brief green strip after a
 * successful reconnect, red strip with a [Try again] button when the
 * 5-minute reconnect budget is exhausted. Hidden in `idle` and `open`
 * (steady state).
 *
 * Sits above the transcript — the post-reconnect notice is also
 * persisted as a system note in the transcript itself, so the gap
 * remains visible after the banner auto-fades.
 */
export function ReconnectBanner({ onRetry }: ReconnectBannerProps) {
  const phase = useConnectionStore((s) => s.phase);
  const bufferedCount = useConnectionStore((s) => s.bufferedChunkCount);
  const [now, setNow] = useState(() => Date.now());
  const [showReconnected, setShowReconnected] = useState(false);
  const wasReconnecting = useRef(false);

  // Live countdown while reconnecting.
  useEffect(() => {
    if (phase.kind !== "reconnecting") return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [phase.kind]);

  // Detect the reconnecting → open transition and flash the green
  // notice for ~6 s.
  useEffect(() => {
    if (phase.kind === "reconnecting") {
      wasReconnecting.current = true;
      return;
    }
    if (phase.kind === "open" && wasReconnecting.current) {
      wasReconnecting.current = false;
      setShowReconnected(true);
      const t = window.setTimeout(() => setShowReconnected(false), RECONNECTED_FLASH_MS);
      return () => window.clearTimeout(t);
    }
  }, [phase.kind]);

  if (phase.kind === "reconnecting") {
    const remainingS = Math.max(0, Math.ceil((phase.nextRetryAtMs - now) / 1000));
    return (
      <Strip tone="warning">
        <Loader2 className="size-4 animate-spin" />
        <span>
          Reconnecting · attempt {phase.attempt + 1} · retrying in {remainingS}s
          {bufferedCount > 0
            ? ` · ${bufferedCount} chunk${bufferedCount === 1 ? "" : "s"} buffered`
            : ""}
        </span>
      </Strip>
    );
  }

  if (phase.kind === "failed") {
    return (
      <Strip tone="error">
        <WifiOff className="size-4" />
        <span className="flex-1">
          Disconnected — session stopped after 5 minutes of failed reconnects.
        </span>
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </Strip>
    );
  }

  if (showReconnected) {
    return (
      <Strip tone="success">
        <AlertTriangle className="size-4" />
        <span>Reconnected. A short gap may appear in the transcript while we caught up.</span>
      </Strip>
    );
  }

  return null;
}

function Strip({
  tone,
  children,
}: {
  tone: "warning" | "error" | "success";
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex animate-rise-in items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        // text-foreground (not accent-foreground): the tint is mostly
        // transparent, so on-amber ink would be dark-on-dark in dark mode.
        tone === "warning" && "border-accent/40 bg-accent/15 text-foreground",
        tone === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
        tone === "success" && "border-accent/30 bg-accent/10 text-foreground",
      )}
    >
      {children}
    </div>
  );
}
