import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { MicLevelPayload } from "@/lib/audio-bridge";

let levelCb: ((p: MicLevelPayload) => void) | null = null;
const unlistenSpy = vi.fn();

vi.mock("@/lib/audio-bridge", () => ({
  subscribeMicLevel: vi.fn(async (_sessionId: string, cb: (p: MicLevelPayload) => void) => {
    levelCb = cb;
    return unlistenSpy;
  }),
}));

import { MicLevelMeter } from "./mic-level-meter";
import { useRecordingStore } from "@/stores/recording-store";

function setRecording(sessionId: string | null) {
  act(() => {
    useRecordingStore.setState({
      phase: sessionId ? "recording" : "idle",
      sessionId,
    });
  });
}

function pushLevel(overrides: Partial<MicLevelPayload>) {
  act(() => {
    levelCb?.({
      sessionId: "s1",
      micRawDbfs: -12,
      micResampledDbfs: -10,
      ...overrides,
    });
  });
}

beforeEach(() => {
  levelCb = null;
  unlistenSpy.mockClear();
  useRecordingStore.setState({ phase: "idle", sessionId: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MicLevelMeter", () => {
  it("renders nothing when not recording", () => {
    const { container } = render(<MicLevelMeter />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a single Mic bar while recording", async () => {
    setRecording("s1");
    render(<MicLevelMeter />);
    await act(async () => {}); // flush the async subscribe

    expect(screen.getByText("Mic")).toBeTruthy();
    expect(screen.getAllByRole("meter")).toHaveLength(1);
  });

  it("reveals both raw dBFS readouts in the info popover", async () => {
    setRecording("s1");
    render(<MicLevelMeter />);
    await act(async () => {});
    pushLevel({ micRawDbfs: -37, micResampledDbfs: -33 });

    fireEvent.click(screen.getByRole("button", { name: /input level details/i }));

    expect(await screen.findByText("Mic (raw)")).toBeTruthy();
    expect(screen.getByText("To STT (resampled)")).toBeTruthy();
    expect(screen.getByText("-37 dBFS")).toBeTruthy();
    expect(screen.getByText("-33 dBFS")).toBeTruthy();
  });

  it("colors the fill with the good band at a healthy level", async () => {
    setRecording("s1");
    render(<MicLevelMeter />);
    await act(async () => {});
    pushLevel({ micRawDbfs: -12, micResampledDbfs: -10 });

    const fill = screen.getByRole("meter").querySelector("[data-band]");
    expect(fill?.getAttribute("data-band")).toBe("good");
  });

  it("surfaces the low-input hint when the signal is near-floor", async () => {
    setRecording("s1");
    render(<MicLevelMeter />);
    await act(async () => {});
    pushLevel({ micRawDbfs: -55, micResampledDbfs: -52 });

    expect(screen.getByText(/low input/i)).toBeTruthy();
    expect(screen.getByText(/system settings/i)).toBeTruthy();
  });

  it("shows no hint when both bands are healthy", async () => {
    setRecording("s1");
    render(<MicLevelMeter />);
    await act(async () => {});
    pushLevel({ micRawDbfs: -12, micResampledDbfs: -10 });

    expect(screen.queryByText(/system settings/i)).toBeNull();
  });
});
