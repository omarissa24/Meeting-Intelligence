import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useUiStore } from "./ui-store";

const initial = useUiStore.getState();

beforeEach(() => {
  useUiStore.setState(
    {
      view: initial.view,
      selectedMeetingId: initial.selectedMeetingId,
      pendingSegmentStartMs: initial.pendingSegmentStartMs,
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
});
