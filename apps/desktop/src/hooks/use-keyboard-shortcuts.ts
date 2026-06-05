import { useEffect, useRef } from "react";

import { isMacPlatform } from "@/lib/platform";
import { canBrowseHistory, canStartRecording, isRecordingActive } from "@/lib/recording-phase";
import { matchShortcut } from "@/lib/shortcuts";
import { useRecordingStore } from "@/stores/recording-store";
import { useUiStore } from "@/stores/ui-store";

export interface KeyboardShortcutActions {
  /** Begin a recording (drives the permission flow). */
  start: () => void;
  /** Stop the live recording. */
  stop: () => void;
}

/**
 * Phase 4 / US-28 — installs one `window` keydown listener that drives the
 * app's in-app shortcuts. Mounted once at the AppShell level.
 *
 * Design notes:
 *   - `start`/`stop` are read from a ref so the listener installs exactly
 *     once and never re-subscribes when those callbacks change identity.
 *   - Live phase/nav state is read via `getState()` inside the handler,
 *     not closed over, for the same reason.
 *   - Every shortcut is gated by the same predicate as its on-screen
 *     affordance (`recording-phase.ts`), so a hotkey can't do something
 *     the visible button wouldn't (e.g. re-entering `start()` mid-session
 *     or yanking the live transcript away to History).
 *   - We `preventDefault` matched combos so the webview's own ⌘R reload /
 *     ⌘F find never fires.
 */
export function useKeyboardShortcuts(actions: KeyboardShortcutActions): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const isMac = isMacPlatform();

    const handler = (event: KeyboardEvent) => {
      const id = matchShortcut(event, isMac);
      if (!id) return;

      event.preventDefault();

      const ui = useUiStore.getState();
      const phase = useRecordingStore.getState().phase;

      switch (id) {
        case "start-recording":
          if (canStartRecording(phase)) actionsRef.current.start();
          break;
        case "stop-recording":
          if (isRecordingActive(phase)) actionsRef.current.stop();
          break;
        case "open-history":
          if (canBrowseHistory(phase)) ui.goHistory();
          break;
        case "focus-search":
          // Search lives inside History, which is unavailable mid-record.
          if (canBrowseHistory(phase)) ui.requestSearchFocus();
          break;
        case "show-shortcuts":
          ui.setShortcutsOpen(true);
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
