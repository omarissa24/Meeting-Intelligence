import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const checkSpy = vi.fn<() => Promise<{ version: string } | null>>();
const downloadSpy = vi.fn(async (_update: unknown) => {});
const hasStagedSpy = vi.fn(() => false);

vi.mock("@/lib/updater-bridge", () => ({
  checkForUpdate: () => checkSpy(),
  downloadUpdate: (u: unknown) => downloadSpy(u),
  hasStagedUpdate: () => hasStagedSpy(),
}));

import { UPDATE_CHECK_INTERVAL_MS, useUpdateChecker } from "./use-update-checker";
import { useUpdateStore } from "@/stores/update-store";

beforeEach(() => {
  useUpdateStore.getState().reset();
  checkSpy.mockReset();
  downloadSpy.mockClear();
  hasStagedSpy.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useUpdateChecker", () => {
  it("checks on mount and downloads a found update in the background", async () => {
    checkSpy.mockResolvedValue({ version: "2.0.0" });
    renderHook(() => useUpdateChecker());
    await waitFor(() => {
      expect(useUpdateStore.getState().status).toBe("ready");
    });
    expect(useUpdateStore.getState().version).toBe("2.0.0");
    expect(downloadSpy).toHaveBeenCalledTimes(1);
  });

  it("returns to idle when no update is available", async () => {
    checkSpy.mockResolvedValue(null);
    renderHook(() => useUpdateChecker());
    await waitFor(() => {
      expect(checkSpy).toHaveBeenCalledTimes(1);
    });
    expect(useUpdateStore.getState().status).toBe("idle");
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it("re-checks on the daily interval", async () => {
    vi.useFakeTimers();
    checkSpy.mockResolvedValue(null);
    renderHook(() => useUpdateChecker());
    // Mount check.
    await vi.waitFor(() => expect(checkSpy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(checkSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(checkSpy).toHaveBeenCalledTimes(3);
  });

  it("does nothing when disabled", () => {
    renderHook(() => useUpdateChecker(false));
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it("skips re-checking while an update is already staged", async () => {
    vi.useFakeTimers();
    checkSpy.mockResolvedValue({ version: "2.0.0" });
    renderHook(() => useUpdateChecker());
    await vi.waitFor(() => expect(useUpdateStore.getState().status).toBe("ready"));
    hasStagedSpy.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(checkSpy).toHaveBeenCalledTimes(1);
  });

  it("records an error status on a failed check", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkSpy.mockRejectedValue(new Error("manifest unreachable"));
    renderHook(() => useUpdateChecker());
    await waitFor(() => {
      expect(useUpdateStore.getState().status).toBe("error");
    });
    expect(useUpdateStore.getState().error).toContain("manifest unreachable");
    expect(warnSpy).toHaveBeenCalled();
  });
});
