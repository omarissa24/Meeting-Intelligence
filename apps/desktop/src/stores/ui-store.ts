import { create } from "zustand";

/**
 * Top-level desktop view selector. Sits next to (not inside)
 * `recording-store` because the two concepts are orthogonal: the user
 * can choose to look at history without disturbing the recording-state
 * machine. AppShell reads both stores and composes the rendered view.
 *
 * `recording`  — the live record / transcript / session-ended surface.
 *                The recording-store decides which sub-view inside.
 * `history`    — paginated past-meeting list.
 * `detail`     — single meeting transcript view; `selectedMeetingId`
 *                must be non-null while in this state.
 *
 * Navigation is intentionally a small flat enum, not a router. We only
 * have three top-level views and no URL story (Tauri webview).
 */

export type AppView = "recording" | "history" | "detail";

export interface UiStoreState {
  view: AppView;
  selectedMeetingId: string | null;
  /**
   * Phase 4 / US-22 deep-link from a search hit. When set, the
   * meeting detail view should scroll its transcript to the segment
   * starting at this offset, then call `consumePendingSegment` to
   * clear the value (so a re-render doesn't keep snapping back).
   */
  pendingSegmentStartMs: number | null;

  /**
   * Phase 4 / US-28 — whether the discoverable Keyboard Shortcuts panel
   * is open. Lives here (not local to AppShell) so two entry points can
   * drive it: the ⌘/Ctrl+? handler and the Settings "Keyboard shortcuts"
   * row, which is rendered in a different subtree.
   */
  shortcutsOpen: boolean;
  /**
   * Phase 4 / US-28 — a staged request to focus the History search bar,
   * mirroring `pendingSegmentStartMs`: the ⌘/Ctrl+F handler sets it,
   * HistoryView consumes it in an effect (`consumeSearchFocus`) once the
   * input is focused. A flag (not a ref) so a fresh History mount that
   * wasn't triggered by ⌘F doesn't steal focus.
   */
  searchFocusPending: boolean;

  goRecording: () => void;
  goHistory: () => void;
  openMeeting: (id: string, opts?: { initialSegmentStartMs?: number }) => void;
  consumePendingSegment: () => void;
  setShortcutsOpen: (open: boolean) => void;
  /** Jump to History (if not already there) and stage a search focus. */
  requestSearchFocus: () => void;
  consumeSearchFocus: () => void;
}

export const useUiStore = create<UiStoreState>()((set) => ({
  view: "recording",
  selectedMeetingId: null,
  pendingSegmentStartMs: null,
  shortcutsOpen: false,
  searchFocusPending: false,

  goRecording: () =>
    set({ view: "recording", selectedMeetingId: null, pendingSegmentStartMs: null }),
  goHistory: () => set({ view: "history", selectedMeetingId: null, pendingSegmentStartMs: null }),
  openMeeting: (id, opts) =>
    set({
      view: "detail",
      selectedMeetingId: id,
      pendingSegmentStartMs: opts?.initialSegmentStartMs ?? null,
    }),
  consumePendingSegment: () => set({ pendingSegmentStartMs: null }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  requestSearchFocus: () =>
    set({ view: "history", selectedMeetingId: null, searchFocusPending: true }),
  consumeSearchFocus: () => set({ searchFocusPending: false }),
}));
