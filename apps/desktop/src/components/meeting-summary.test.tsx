import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MeetingSummary } from "@meeting-intelligence/shared-types";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
}));

import { MeetingSummary as MeetingSummaryView } from "./meeting-summary";
import { TooltipProvider } from "@/components/ui/tooltip";

const MEETING_ID = "11111111-1111-1111-1111-111111111111";

function makeSummary(overrides: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    status: "completed",
    summary: "We discussed the Q3 plan and agreed to ship next month.",
    decisions: ["Approve Q3 plan."],
    topics: [{ name: "Q3 plan", durationSeconds: 720 }],
    actionItems: [
      {
        id: "ai-1",
        description: "Send the team the budget memo",
        owner: "Omar",
        deadline: "2026-06-15",
        completed: false,
        completedAt: null,
        orderIndex: 0,
      },
      {
        id: "ai-2",
        description: "Schedule follow-up",
        owner: null,
        deadline: null,
        completed: false,
        completedAt: null,
        orderIndex: 1,
      },
    ],
    confidenceLow: false,
    modelVersion: "test-model",
    inputTokens: 1234,
    outputTokens: 567,
    error: null,
    generatedAt: "2026-06-03T12:00:00Z",
    regeneratedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

function renderView(opts: {
  status?: MeetingSummary["status"];
  summary?: MeetingSummary | null;
  isRegenerating?: boolean;
  onRegenerate?: () => void;
  onPatchActionItem?: (id: string, body: object) => void;
}) {
  const noop = () => undefined;
  // TooltipProvider mirrors App.tsx — the header icon actions render
  // inside Tooltips.
  return render(
    <TooltipProvider>
      <MeetingSummaryView
        meetingId={MEETING_ID}
        status={opts.status ?? "completed"}
        summary={opts.summary ?? makeSummary()}
        isRegenerating={opts.isRegenerating ?? false}
        onRegenerate={opts.onRegenerate ?? noop}
        onPatchActionItem={opts.onPatchActionItem ?? noop}
      />
    </TooltipProvider>,
  );
}

describe("MeetingSummary — state machine", () => {
  it("renders the loading card while pending", () => {
    renderView({ status: "pending", summary: null });
    expect(screen.getByText(/Generating summary/)).toBeInTheDocument();
  });

  it("renders the loading card while processing", () => {
    renderView({ status: "processing", summary: null });
    expect(screen.getByText(/Generating summary/)).toBeInTheDocument();
  });

  it("renders the too-short message", () => {
    renderView({ status: "too_short", summary: null });
    expect(screen.getByText(/Recording too short to summarise/)).toBeInTheDocument();
  });

  it("renders the failed message with a Retry button", () => {
    const onRegenerate = vi.fn();
    renderView({
      status: "failed",
      summary: makeSummary({ status: "failed", error: "validation failed" }),
      onRegenerate,
    });
    expect(screen.getByText(/validation failed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("renders the completed summary with sections and action items", () => {
    renderView({});
    expect(
      screen.getByText("We discussed the Q3 plan and agreed to ship next month."),
    ).toBeInTheDocument();
    expect(screen.getByText("Approve Q3 plan.")).toBeInTheDocument();
    expect(screen.getByText("Send the team the budget memo")).toBeInTheDocument();
    expect(screen.getByText("Schedule follow-up")).toBeInTheDocument();
    // Topic name appears in the topic list (alongside duration).
    expect(screen.getByText("12m 00s")).toBeInTheDocument();
  });

  it("hides the owner/deadline meta line when both are unset", () => {
    renderView({});
    // ai-1 has a real owner + deadline → meta shown.
    expect(screen.getByText("Omar")).toBeInTheDocument();
    expect(screen.getByText("2026-06-15")).toBeInTheDocument();
    // ai-2 has neither → no "Unassigned · No deadline set" noise.
    expect(screen.queryByText(/Unassigned/)).toBeNull();
    expect(screen.queryByText(/No deadline set/)).toBeNull();
  });

  it("offers copy-action-items and export in the overflow menu", async () => {
    renderView({});
    // Radix menu triggers open on keyboard activation (pointer events
    // need a real pointerdown sequence jsdom doesn't synthesise well).
    fireEvent.keyDown(screen.getByRole("button", { name: /more summary actions/i }), {
      key: "Enter",
    });
    expect(await screen.findByText("Copy action items")).toBeInTheDocument();
    expect(screen.getByText("Export as text")).toBeInTheDocument();
  });

  it("surfaces the confidence-low footnote when flagged", () => {
    renderView({
      summary: makeSummary({ confidenceLow: true }),
    });
    expect(screen.getByText(/Speaker diarisation was uncertain/)).toBeInTheDocument();
  });

  it("renders empty-state copy for sections with no entries", () => {
    renderView({
      summary: makeSummary({
        decisions: [],
        actionItems: [],
        topics: [],
      }),
    });
    expect(screen.getByText("No decisions recorded.")).toBeInTheDocument();
    expect(screen.getByText("No action items recorded.")).toBeInTheDocument();
    expect(screen.getByText("No topics recorded.")).toBeInTheDocument();
  });
});

describe("MeetingSummary — action item interactions", () => {
  it("toggling completion calls onPatchActionItem with completed=true", () => {
    const onPatch = vi.fn();
    renderView({ onPatchActionItem: onPatch });
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]);
    expect(onPatch).toHaveBeenCalledWith("ai-1", { completed: true });
  });

  it("regenerate opens a confirm dialog and calls onRegenerate on confirm", () => {
    const onRegenerate = vi.fn();
    renderView({ onRegenerate });
    fireEvent.click(screen.getByRole("button", { name: /regenerate summary/i }));
    expect(screen.getByText(/Regenerate this summary\?/)).toBeInTheDocument();
    expect(onRegenerate).not.toHaveBeenCalled();
    // The dialog has its own "Regenerate" button.
    const buttons = screen.getAllByRole("button", { name: /regenerate/i });
    const confirm = buttons.find(
      (b) => !b.getAttribute("aria-label")?.includes("Regenerate summary"),
    );
    expect(confirm).toBeTruthy();
    fireEvent.click(confirm!);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });
});
