import { useEffect, useState } from "react";
import { History as HistoryIcon } from "lucide-react";
import { toast } from "sonner";

import { ConnectionStatus } from "@/components/connection-status";
import { HistoryView } from "@/components/history-view";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { MeetingDetailView } from "@/components/meeting-detail-view";
import { MeetingDetectionPrompt } from "@/components/meeting-detection-prompt";
import { PermissionPrompt } from "@/components/permission-prompt";
import { RecentMeetings } from "@/components/recent-meetings";
import { ReconnectBanner } from "@/components/reconnect-banner";
import { RecordControl } from "@/components/record-control";
import { SessionEndedView } from "@/components/session-ended-view";
import { SettingsSheet } from "@/components/settings-sheet";
import { TranscriptPanel } from "@/components/transcript-panel";
import { Button } from "@/components/ui/button";
import { UpdateBanner } from "@/components/update-banner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useMeetingDetection } from "@/hooks/use-meeting-detection";
import { useRecording } from "@/hooks/use-recording";
import { useUpdateChecker } from "@/hooks/use-update-checker";
import { CLIENT_VERSION, IS_PRODUCTION } from "@/lib/config";
import { canBrowseHistory } from "@/lib/recording-phase";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import logo from "@/assets/marens-logo.png";
import logoDark from "@/assets/marens-logo-dark.png";

export function AppShell() {
  const { phase, elapsedMs, error, permissionState, start, stop, requestPermissions } =
    useRecording();

  const view = useUiStore((s) => s.view);
  const selectedMeetingId = useUiStore((s) => s.selectedMeetingId);
  const goHistory = useUiStore((s) => s.goHistory);

  const [permPromptOpen, setPermPromptOpen] = useState(false);

  // US-28: in-app keyboard shortcuts. Mounted here because AppShell is the
  // single authenticated surface that already holds `start`/`stop` and the
  // navigation store. start/stop are passed by identity; the hook ref's
  // them so the listener installs once.
  useKeyboardShortcuts({ start, stop });

  // Phase 6: run the meeting detector while authenticated + opted in. Gated on
  // `hydrated` so we read the user's real setting (not the default) before
  // spawning the monitor. Mounted here so logout (AppShell unmount) tears it
  // down.
  const autoDetectMeetings = useSettingsStore((s) => s.autoDetectMeetings);
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  useMeetingDetection(settingsHydrated && autoDetectMeetings);

  // US-24: check for updates on launch + daily; downloads happen in the
  // background and the banner below only surfaces when a session isn't
  // in flight. Production builds only — `tauri:dev` has no signed
  // bundle to update against.
  useUpdateChecker(IS_PRODUCTION);

  // Treat `stopping` and `stopped` as one rendering branch — the user
  // perceives "I clicked Stop" as instantaneous; the SessionEndedView
  // mounts on the same paint as the click. The Rust drain finishes in
  // the background and the precise durationMs lands when confirmStop
  // runs.
  const isSessionEnded = phase === "stopping" || phase === "stopped";

  // The History entry-point only makes sense when the recording surface
  // is idle — opening it mid-recording would yank the live transcript
  // out from under the user. Shared with the ⌘/Ctrl+H shortcut so the two
  // agree (see lib/recording-phase.ts).
  const historyBrowsable = canBrowseHistory(phase);

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
    <div className="flex h-screen flex-col bg-background app-atmosphere text-foreground">
      <header className="flex items-center justify-between px-8 py-5">
        <h1 className="flex items-center leading-none">
          {/* marens logo (mark + wordmark) — theme-aware. */}
          <img src={logo} alt="Marens" className="h-8 w-auto dark:hidden" />
          <img src={logoDark} alt="Marens" className="hidden h-8 w-auto dark:block" />
        </h1>
        <div className="flex items-center gap-1">
          {historyBrowsable && view === "recording" ? (
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

      <UpdateBanner />

      <main className="flex flex-1 flex-col overflow-hidden px-8 pb-6">
        <div key={view} className="flex min-h-0 flex-1 animate-rise-in flex-col gap-6">
          {view === "recording" ? (
            isSessionEnded ? (
              <>
                <ReconnectBanner onRetry={handleRetry} />
                <section className="min-h-0 flex-1">
                  <SessionEndedView />
                </section>
              </>
            ) : (
              // Keyed on home-vs-live so the swap between the hero/recent
              // surface and the in-session transcript rises in as one unit.
              <div
                key={historyBrowsable ? "home" : "live"}
                className="flex min-h-0 flex-1 animate-rise-in flex-col gap-6"
              >
                <section className={cn("flex justify-center", historyBrowsable ? "py-10" : "py-6")}>
                  <RecordControl
                    variant={historyBrowsable ? "hero" : "compact"}
                    phase={phase}
                    elapsedMs={elapsedMs}
                    onStart={handleStart}
                    onStop={handleStop}
                  />
                </section>
                <ReconnectBanner onRetry={handleRetry} />
                <section className="min-h-0 flex-1">
                  {historyBrowsable ? <RecentMeetings /> : <TranscriptPanel />}
                </section>
              </div>
            )
          ) : view === "history" ? (
            <section className="min-h-0 flex-1">
              <HistoryView />
            </section>
          ) : view === "detail" && selectedMeetingId ? (
            <section className="min-h-0 flex-1">
              <MeetingDetailView meetingId={selectedMeetingId} />
            </section>
          ) : null}
        </div>
      </main>

      <footer className="flex items-center justify-between gap-4 border-t border-border px-8 py-3 text-xs">
        {/* Pipeline diagnostics are for debugging the audio chain — dev
            builds only. Production shows the app version instead. */}
        <span className="text-muted-foreground">
          {IS_PRODUCTION ? `v${CLIENT_VERSION}` : "16 kHz mono PCM · 1 s payloads · in-memory echo"}
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

      <MeetingDetectionPrompt
        onStart={() => {
          void start();
        }}
      />

      <KeyboardShortcutsDialog />
    </div>
  );
}
