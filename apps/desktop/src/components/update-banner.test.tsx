import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { installSpy } = vi.hoisted(() => ({
  installSpy: vi.fn(async () => {}),
}));

vi.mock("@/lib/updater-bridge", () => ({
  installStagedUpdate: installSpy,
}));

import { UpdateBanner } from "./update-banner";
import { useRecordingStore } from "@/stores/recording-store";
import { useUpdateStore } from "@/stores/update-store";

function setUpdateReady(version = "1.2.0") {
  act(() => {
    useUpdateStore.setState({ status: "ready", version, dismissed: false });
  });
}

function setPhase(phase: "idle" | "recording" | "starting" | "stopping" | "stopped") {
  act(() => {
    useRecordingStore.setState({ phase });
  });
}

beforeEach(() => {
  useUpdateStore.getState().reset();
  useRecordingStore.setState({ phase: "idle" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UpdateBanner", () => {
  it("is hidden when no update is staged", () => {
    render(<UpdateBanner />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the staged version with a restart action when ready", () => {
    setUpdateReady("1.2.0");
    render(<UpdateBanner />);
    expect(screen.getByRole("status").textContent).toContain("1.2.0");
    expect(screen.getByRole("button", { name: /restart to update/i })).toBeTruthy();
  });

  it("is suppressed while a recording session is in flight", () => {
    setUpdateReady();
    for (const phase of ["starting", "recording", "stopping"] as const) {
      setPhase(phase);
      const { unmount } = render(<UpdateBanner />);
      expect(screen.queryByRole("status")).toBeNull();
      unmount();
    }
  });

  it("reappears once the session ends", () => {
    setUpdateReady();
    setPhase("recording");
    render(<UpdateBanner />);
    expect(screen.queryByRole("status")).toBeNull();
    setPhase("stopped");
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("installs the staged update on restart click", () => {
    setUpdateReady();
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole("button", { name: /restart to update/i }));
    expect(installSpy).toHaveBeenCalledTimes(1);
  });

  it("dismiss hides the banner without installing", () => {
    setUpdateReady();
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss update/i }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(installSpy).not.toHaveBeenCalled();
  });
});
