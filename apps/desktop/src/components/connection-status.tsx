import { cn } from "@/lib/utils";
import type { WsReadyState } from "@/lib/ws-client";

const LABEL: Record<WsReadyState, string> = {
  connecting: "Connecting",
  open: "Connected",
  closing: "Closing",
  closed: "Offline",
};

export function ConnectionStatus({ state }: { state: WsReadyState }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full transition-colors",
          state === "open"
            ? "bg-accent"
            : state === "connecting"
              ? "bg-muted-foreground/60"
              : "bg-muted-foreground/30",
        )}
      />
      <span className="tabular-nums">{LABEL[state]}</span>
    </div>
  );
}
