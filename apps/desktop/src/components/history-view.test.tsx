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
  audioObjectKey: null,
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

  it("derives a date-based display title for blank titles", async () => {
    mockApiJson.mockResolvedValueOnce({
      items: [sampleMeeting({ id: "c", title: null })],
      nextCursor: null,
    } as MeetingListResponse);

    renderWithQuery(<HistoryView />);

    // Same Intl options as displayMeetingTitle so the assertion holds in
    // any runner locale.
    const stamp = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date("2026-06-03T15:00:00Z"));
    expect(await screen.findByText(`Meeting — ${stamp}`)).toBeInTheDocument();
  });

  it("falls back to 'Untitled meeting' when there is no title and no start time", async () => {
    mockApiJson.mockResolvedValueOnce({
      items: [sampleMeeting({ id: "d", title: null, startedAt: null })],
      nextCursor: null,
    } as MeetingListResponse);

    renderWithQuery(<HistoryView />);

    expect(await screen.findByText(/Untitled meeting/i)).toBeInTheDocument();
  });

  it("groups meetings from different days under separate day headers", async () => {
    mockApiJson.mockResolvedValueOnce({
      items: [
        sampleMeeting({ id: "a", title: "Same day A", startedAt: "2026-06-03T15:00:00Z" }),
        sampleMeeting({ id: "b", title: "Same day B", startedAt: "2026-06-03T09:00:00Z" }),
        sampleMeeting({ id: "c", title: "Earlier day", startedAt: "2025-01-10T09:00:00Z" }),
      ],
      nextCursor: null,
    } as MeetingListResponse);

    renderWithQuery(<HistoryView />);
    await screen.findByText("Same day A");

    // Two distinct calendar days → exactly two grouped sections.
    const headers = document.querySelectorAll("section > h3");
    expect(headers).toHaveLength(2);
    // The two same-day meetings share the first section.
    const firstSection = headers[0].closest("section");
    expect(firstSection?.textContent).toContain("Same day A");
    expect(firstSection?.textContent).toContain("Same day B");
    expect(firstSection?.textContent).not.toContain("Earlier day");
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
