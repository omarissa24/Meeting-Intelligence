import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meeting, MeetingListResponse } from "@meeting-intelligence/shared-types";

import { useUiStore } from "@/stores/ui-store";

const mockApiJson = vi.fn();

vi.mock("@/lib/api-client", () => ({
  apiJson: (...args: unknown[]) => mockApiJson(...args),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: string,
    ) {
      super(`api ${status}`);
    }
  },
}));

import { HistoryView } from "./history-view";

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const sampleMeeting = (overrides: Partial<Meeting> = {}): Meeting => ({
  id: "11111111-1111-1111-1111-111111111111",
  title: "Quarterly review",
  tags: ["finance"],
  status: "completed",
  startedAt: "2026-06-03T15:00:00Z",
  endedAt: "2026-06-03T15:42:00Z",
  durationSeconds: 2520,
  speakerCount: 3,
  ...overrides,
});

beforeEach(() => {
  mockApiJson.mockReset();
  useUiStore.setState({ view: "history", selectedMeetingId: null }, false);
});

afterEach(() => {
  cleanup();
});

describe("HistoryView", () => {
  it("renders the empty state when the API returns no items", async () => {
    mockApiJson.mockResolvedValueOnce({ items: [], nextCursor: null } as MeetingListResponse);

    renderWithQuery(<HistoryView />);

    expect(await screen.findByText(/No meetings yet/i)).toBeInTheDocument();
  });

  it("renders meeting rows when the API returns items", async () => {
    mockApiJson.mockResolvedValueOnce({
      items: [
        sampleMeeting({ id: "a", title: "All-hands" }),
        sampleMeeting({ id: "b", title: "1:1 with Ada" }),
      ],
      nextCursor: null,
    } as MeetingListResponse);

    renderWithQuery(<HistoryView />);

    expect(await screen.findByText("All-hands")).toBeInTheDocument();
    expect(screen.getByText("1:1 with Ada")).toBeInTheDocument();
  });

  it("falls back to 'Untitled meeting' for blank titles", async () => {
    mockApiJson.mockResolvedValueOnce({
      items: [sampleMeeting({ id: "c", title: null })],
      nextCursor: null,
    } as MeetingListResponse);

    renderWithQuery(<HistoryView />);

    expect(await screen.findByText(/Untitled meeting/i)).toBeInTheDocument();
  });

  it("clicking a row calls openMeeting", async () => {
    mockApiJson.mockResolvedValueOnce({
      items: [sampleMeeting({ id: "row-id", title: "Sync" })],
      nextCursor: null,
    } as MeetingListResponse);
    const openSpy = vi.spyOn(useUiStore.getState(), "openMeeting");

    renderWithQuery(<HistoryView />);
    const row = await screen.findByRole("button", { name: /Sync/ });
    fireEvent.click(row);

    expect(openSpy).toHaveBeenCalledWith("row-id");
  });

  it("shows Load more when there is a next cursor", async () => {
    mockApiJson.mockResolvedValueOnce({
      items: [sampleMeeting({ id: "a" })],
      nextCursor: "cursor-page-2",
    } as MeetingListResponse);

    renderWithQuery(<HistoryView />);

    expect(await screen.findByRole("button", { name: /Load more/i })).toBeInTheDocument();
  });

  it("shows the error view + retry button on failure", async () => {
    mockApiJson.mockRejectedValueOnce(new Error("network down"));

    renderWithQuery(<HistoryView />);

    expect(await screen.findByText(/Couldn't load meetings/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });
});
