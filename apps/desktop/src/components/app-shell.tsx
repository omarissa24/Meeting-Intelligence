import { useEffect, useState } from "react";
import { History as HistoryIcon } from "lucide-react";
import { toast } from "sonner";

import { ConnectionStatus } from "@/components/connection-status";
import { HistoryView } from "@/components/history-view";
import { MeetingDetailView } from "@/components/meeting-detail-view";
import { PermissionPrompt } from "@/components/permission-prompt";
import { ReconnectBanner } from "@/components/reconnect-banner";
import { RecordControl } from "@/components/record-control";
import { SessionEndedView } from "@/components/session-ended-view";
import { SettingsSheet } from "@/components/settings-sheet";
import { TranscriptPanel } from "@/components/transcript-panel";
import { Button } from "@/components/ui/button";
import { useRecording } from "@/hooks/use-recording";
import { useUiStore } from "@/stores/ui-store";

export function AppShell() {
  const { phase, elapsedMs, error, permissionState, start, stop, requestPermissions } =
    useRecording();

  const view = useUiStore((s) => s.view);
  const selectedMeetingId = useUiStore((s) => s.selectedMeetingId);
  const goHistory = useUiStore((s) => s.goHistory);

  const [permPromptOpen, setPermPromptOpen] = useState(false);

  // Treat `stopping` and `stopped` as one rendering branch — the user
  // perceives "I clicked Stop" as instantaneous; the SessionEndedView
  // mounts on the same paint as the click. The Rust drain finishes in
  // the background and the precise durationMs lands when confirmStop
  // runs.
  const isSessionEnded = phase === "stopping" || phase === "stopped";

  // The History entry-point only makes sense when the recording surface
  // is idle — opening it mid-recording would yank the live transcript
  // out from under the user. Idle/error/permission flows are fine.
  const canBrowseHistory =
    phase === "idle" || phase === "checking-permissions" || phase === "requesting-permissions";

  // Auto-open the explainer dialog whenever the user lands in
  // not-determined territory — either on first launch or after the
  // start flow detected a missing grant. The user can dismiss; the
  // dialog re-opens next time they click Record while still
  // not-determined.
  useEffect(() => {
    if (permissionState === "not-determined") {
      setPermPromptOpen(true);
    } else {
      setPermPromptOpen(false);
    }
  }, [permissionState]);

  // Surface recording errors via the existing Sonner toaster. Non-fatal
  // permission flow cancellations come through as empty strings (see
  // use-recording.ts) — those are intentional and not surfaced.
  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  const handleStart = () => {
    void start();
  };

  const handleStop = () => {
    void stop();
  };

  const handleRetry = () => {
    // After a `failed` phase the recording store is already `stopped`
    // (auto-stop ran). Just kick off a fresh session.
    void start();
  };

  const handlePermissionRequest = async () => {
    const next = await requestPermissions();
    if (next === "granted") {
      // Got both grants — start the session immediately so the user's
      // initial click on Record carries through without a second tap.
      setPermPromptOpen(false);
      void start();
    }
    // On denied / unknown, leave the dialog open so the user sees
    // the toast surfacing the System Settings hint.
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-8 py-5">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl font-normal leading-none tracking-tight">
            Meeting Intelligence
          </h1>
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Foundation
          </span>
        </div>
        <div className="flex items-center gap-1">
          {canBrowseHistory && view === "recording" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open meeting history"
              onClick={goHistory}
            >
              <HistoryIcon />
            </Button>
          ) : null}
          <SettingsSheet />
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-6 overflow-hidden px-8 pb-6">
        {view === "recording" ? (
          <>
            {!isSessionEnded ? (
              <section className="flex justify-center py-6">
                <RecordControl
                  phase={phase}
                  elapsedMs={elapsedMs}
                  onStart={handleStart}
                  onStop={handleStop}
                />
              </section>
            ) : null}
            <ReconnectBanner onRetry={handleRetry} />
            <section className="min-h-0 flex-1">
              {isSessionEnded ? <SessionEndedView /> : <TranscriptPanel />}
            </section>
          </>
        ) : view === "history" ? (
          <section className="min-h-0 flex-1">
            <HistoryView />
          </section>
        ) : view === "detail" && selectedMeetingId ? (
          <section className="min-h-0 flex-1">
            <MeetingDetailView meetingId={selectedMeetingId} />
          </section>
        ) : null}
      </main>

      <footer className="flex items-center justify-between gap-4 border-t border-border px-8 py-3 text-xs">
        <span className="text-muted-foreground">
          16 kHz mono PCM · 1 s payloads · in-memory echo
        </span>
        <ConnectionStatus />
      </footer>

      <PermissionPrompt
        open={permPromptOpen}
        onOpenChange={setPermPromptOpen}
        onRequest={() => {
          void handlePermissionRequest();
        }}
        pending={phase === "requesting-permissions"}
      />
    </div>
  );
}
