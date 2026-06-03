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

  goRecording: () => void;
  goHistory: () => void;
  openMeeting: (id: string) => void;
}

export const useUiStore = create<UiStoreState>()((set) => ({
  view: "recording",
  selectedMeetingId: null,

  goRecording: () => set({ view: "recording", selectedMeetingId: null }),
  goHistory: () => set({ view: "history", selectedMeetingId: null }),
  openMeeting: (id) => set({ view: "detail", selectedMeetingId: id }),
}));
