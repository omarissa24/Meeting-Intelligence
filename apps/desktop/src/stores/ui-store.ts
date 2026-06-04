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

  goRecording: () => void;
  goHistory: () => void;
  openMeeting: (id: string, opts?: { initialSegmentStartMs?: number }) => void;
  consumePendingSegment: () => void;
}

export const useUiStore = create<UiStoreState>()((set) => ({
  view: "recording",
  selectedMeetingId: null,
  pendingSegmentStartMs: null,

  goRecording: () =>
    set({ view: "recording", selectedMeetingId: null, pendingSegmentStartMs: null }),
  goHistory: () =>
    set({ view: "history", selectedMeetingId: null, pendingSegmentStartMs: null }),
  openMeeting: (id, opts) =>
    set({
      view: "detail",
      selectedMeetingId: id,
      pendingSegmentStartMs: opts?.initialSegmentStartMs ?? null,
    }),
  consumePendingSegment: () => set({ pendingSegmentStartMs: null }),
}));
