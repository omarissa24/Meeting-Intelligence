import { beforeEach, describe, expect, it } from "vitest";

import type { MeetingDetectedPayload } from "@/lib/detection-bridge";

import { useDetectionStore } from "./detection-store";
import { useRecordingStore } from "./recording-store";

function payload(overrides?: Partial<MeetingDetectedPayload>): MeetingDetectedPayload {
  return {
    appId: "zoom",
    displayName: "Zoom",
    isBrowserHeuristic: false,
    detectionId: 1,
    ...overrides,
  };
}

describe("detection-store", () => {
  beforeEach(() => {
    useDetectionStore.setState({ active: null });
    useRecordingStore.getState().reset(); // phase → idle
  });

  it("onDetected sets the active prompt when the recorder is idle", () => {
    useDetectionStore.getState().onDetected(payload());
    expect(useDetectionStore.getState().active).toEqual(payload());
  });

  it("onDetected is ignored unless the recording phase is idle", () => {
    useRecordingStore.setState({ phase: "recording" });
    useDetectionStore.getState().onDetected(payload());
    expect(useDetectionStore.getState().active).toBeNull();
  });

  it("onEnded clears the prompt only when the detectionId matches", () => {
    useDetectionStore.getState().onDetected(payload({ detectionId: 7 }));
    expect(useDetectionStore.getState().active?.detectionId).toBe(7);

    // Stale end for a previous detection is a no-op.
    useDetectionStore.getState().onEnded(6);
    expect(useDetectionStore.getState().active?.detectionId).toBe(7);

    // Matching end clears it.
    useDetectionStore.getState().onEnded(7);
    expect(useDetectionStore.getState().active).toBeNull();
  });

  it("dismiss clears the active prompt", () => {
    useDetectionStore.getState().onDetected(payload());
    useDetectionStore.getState().dismiss();
    expect(useDetectionStore.getState().active).toBeNull();
  });
});
