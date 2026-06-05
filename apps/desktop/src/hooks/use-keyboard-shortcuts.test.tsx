import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Force a non-mac platform so the primary modifier is Ctrl — keeps the
// dispatched events deterministic regardless of the jsdom navigator.
vi.mock("@/lib/platform", () => ({ isMacPlatform: () => false }));

import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import type { RecordingPhase } from "@/stores/recording-store";
import { useRecordingStore } from "@/stores/recording-store";
import { useUiStore } from "@/stores/ui-store";

function Harness({ start, stop }: { start: () => void; stop: () => void }) {
  useKeyboardShortcuts({ start, stop });
  return null;
}

function press(key: string, opts: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: opts.ctrlKey ?? true,
    shiftKey: opts.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

function setPhase(phase: RecordingPhase) {
  useRecordingStore.setState({ phase }, false);
}

beforeEach(() => {
  setPhase("idle");
  useUiStore.setState(
    { view: "recording", selectedMeetingId: null, shortcutsOpen: false, searchFocusPending: false },
    false,
  );
});

afterEach(() => {
  cleanup();
  setPhase("idle");
});

describe("useKeyboardShortcuts", () => {
  it("Ctrl+R starts a recording when idle, and preventDefaults", () => {
    const start = vi.fn();
    const stop = vi.fn();
    render(<Harness start={start} stop={stop} />);

    const event = press("r");
    expect(start).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Ctrl+R does NOT re-enter start() while already recording", () => {
    const start = vi.fn();
    render(<Harness start={start} stop={() => undefined} />);
    setPhase("recording");

    press("r");
    expect(start).not.toHaveBeenCalled();
  });

  it("Ctrl+. stops only while a session is live", () => {
    const stop = vi.fn();
    render(<Harness start={() => undefined} stop={stop} />);

    press("."); // idle → no-op
    expect(stop).not.toHaveBeenCalled();

    setPhase("recording");
    press(".");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+H opens History when idle but not mid-recording", () => {
    render(<Harness start={() => undefined} stop={() => undefined} />);

    press("h");
    expect(useUiStore.getState().view).toBe("history");

    // Reset to recording surface, go live, and confirm H is inert.
    useUiStore.setState({ view: "recording" }, false);
    setPhase("recording");
    press("h");
    expect(useUiStore.getState().view).toBe("recording");
  });

  it("Ctrl+F stages a search-focus request (and navigates to History)", () => {
    render(<Harness start={() => undefined} stop={() => undefined} />);

    press("f");
    const s = useUiStore.getState();
    expect(s.view).toBe("history");
    expect(s.searchFocusPending).toBe(true);
  });

  it("Ctrl+Shift+/ opens the shortcuts panel, even while recording", () => {
    render(<Harness start={() => undefined} stop={() => undefined} />);
    setPhase("recording");

    press("/", { shiftKey: true });
    expect(useUiStore.getState().shortcutsOpen).toBe(true);
  });

  it("ignores unmapped combos and bare keys", () => {
    const start = vi.fn();
    render(<Harness start={start} stop={() => undefined} />);

    const unmapped = press("k");
    expect(unmapped.defaultPrevented).toBe(false);

    const bare = press("r", { ctrlKey: false });
    expect(bare.defaultPrevented).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("tears down the listener on unmount", () => {
    const start = vi.fn();
    const { unmount } = render(<Harness start={start} stop={() => undefined} />);
    unmount();

    press("r");
    expect(start).not.toHaveBeenCalled();
  });
});
