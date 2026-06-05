import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useUiStore } from "./ui-store";

const initial = useUiStore.getState();

beforeEach(() => {
  useUiStore.setState(
    {
      view: initial.view,
      selectedMeetingId: initial.selectedMeetingId,
      pendingSegmentStartMs: initial.pendingSegmentStartMs,
      shortcutsOpen: initial.shortcutsOpen,
      searchFocusPending: initial.searchFocusPending,
    },
    false,
  );
});

afterEach(() => {
  useUiStore.setState(
    {
      view: initial.view,
      selectedMeetingId: initial.selectedMeetingId,
      pendingSegmentStartMs: initial.pendingSegmentStartMs,
      shortcutsOpen: initial.shortcutsOpen,
      searchFocusPending: initial.searchFocusPending,
    },
    false,
  );
});

describe("ui-store", () => {
  it("starts on the recording view with no selection", () => {
    const s = useUiStore.getState();
    expect(s.view).toBe("recording");
    expect(s.selectedMeetingId).toBeNull();
  });

  it("goHistory swaps to history and clears selection", () => {
    useUiStore.setState({ view: "detail", selectedMeetingId: "abc" }, false);
    useUiStore.getState().goHistory();
    const s = useUiStore.getState();
    expect(s.view).toBe("history");
    expect(s.selectedMeetingId).toBeNull();
  });

  it("openMeeting goes to detail with the id captured", () => {
    useUiStore.getState().openMeeting("meeting-42");
    const s = useUiStore.getState();
    expect(s.view).toBe("detail");
    expect(s.selectedMeetingId).toBe("meeting-42");
  });

  it("goRecording resets selection too", () => {
    useUiStore.getState().openMeeting("meeting-42");
    useUiStore.getState().goRecording();
    const s = useUiStore.getState();
    expect(s.view).toBe("recording");
    expect(s.selectedMeetingId).toBeNull();
  });

  it("openMeeting with initialSegmentStartMs stages the deep-link offset", () => {
    useUiStore.getState().openMeeting("meeting-7", { initialSegmentStartMs: 12_345 });
    const s = useUiStore.getState();
    expect(s.view).toBe("detail");
    expect(s.selectedMeetingId).toBe("meeting-7");
    expect(s.pendingSegmentStartMs).toBe(12_345);
  });

  it("consumePendingSegment clears the deep-link offset only", () => {
    useUiStore.getState().openMeeting("meeting-7", { initialSegmentStartMs: 99 });
    useUiStore.getState().consumePendingSegment();
    const s = useUiStore.getState();
    expect(s.view).toBe("detail");
    expect(s.selectedMeetingId).toBe("meeting-7");
    expect(s.pendingSegmentStartMs).toBeNull();
  });

  it("openMeeting without a hint resets the prior pending segment", () => {
    useUiStore.getState().openMeeting("meeting-1", { initialSegmentStartMs: 42 });
    useUiStore.getState().openMeeting("meeting-2");
    expect(useUiStore.getState().pendingSegmentStartMs).toBeNull();
  });

  it("setShortcutsOpen toggles the help panel flag", () => {
    expect(useUiStore.getState().shortcutsOpen).toBe(false);
    useUiStore.getState().setShortcutsOpen(true);
    expect(useUiStore.getState().shortcutsOpen).toBe(true);
    useUiStore.getState().setShortcutsOpen(false);
    expect(useUiStore.getState().shortcutsOpen).toBe(false);
  });

  it("requestSearchFocus jumps to history and stages a focus request", () => {
    useUiStore.setState({ view: "detail", selectedMeetingId: "abc" }, false);
    useUiStore.getState().requestSearchFocus();
    const s = useUiStore.getState();
    expect(s.view).toBe("history");
    expect(s.selectedMeetingId).toBeNull();
    expect(s.searchFocusPending).toBe(true);
  });

  it("consumeSearchFocus clears the staged focus request only", () => {
    useUiStore.getState().requestSearchFocus();
    useUiStore.getState().consumeSearchFocus();
    const s = useUiStore.getState();
    expect(s.view).toBe("history");
    expect(s.searchFocusPending).toBe(false);
  });
});
