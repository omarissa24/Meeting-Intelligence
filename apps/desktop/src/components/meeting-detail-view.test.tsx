import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MeetingDetail } from "@meeting-intelligence/shared-types";

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

import { MeetingDetailView } from "./meeting-detail-view";

const MEETING_ID = "11111111-1111-1111-1111-111111111111";

function makeDetail(overrides: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    id: MEETING_ID,
    title: "Quarterly review",
    tags: ["finance"],
    status: "completed",
    startedAt: "2026-06-03T15:00:00Z",
    endedAt: "2026-06-03T15:42:00Z",
    durationSeconds: 2520,
    speakerCount: 2,
    segments: [
      {
        id: "seg-1",
        speakerId: "spk-0",
        text: "Hello world",
        startMs: 0,
        endMs: 1000,
        isFinal: true,
      },
    ],
    ...overrides,
  };
}

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  mockApiJson.mockReset();
});

afterEach(() => {
  cleanup();
});

// `mockApiJson` is called for the GET on mount and again on the
// post-PATCH cache invalidation. Tests that exercise PATCH layer their
// own mock responses on top via `mockResolvedValueOnce`. We default
// the GET response to the supplied detail and use `mockResolvedValue`
// (no -Once) as a backstop for any cache-invalidation refetch so the
// console doesn't get cluttered with React Query "data cannot be
// undefined" warnings.
function primeFetches(detail: MeetingDetail) {
  mockApiJson.mockResolvedValueOnce(detail); // useMeetingDetail GET on mount
  mockApiJson.mockResolvedValue(detail); // backstop for post-PATCH refetches
}

describe("MeetingDetailView — title editing", () => {
  it("commits a PATCH on Enter when the title changes", async () => {
    const detail = makeDetail({ title: "Old name" });
    primeFetches(detail);
    mockApiJson.mockResolvedValueOnce({ ...detail, title: "New name" });

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    // Wait for the title button to render.
    const titleBtn = await screen.findByRole("button", { name: /Edit meeting title/i });
    fireEvent.click(titleBtn);

    const input = await screen.findByRole("textbox", { name: /Meeting title/i });
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      const patchCall = mockApiJson.mock.calls.find(
        (c) => (c[0] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      expect((patchCall![0] as { path: string }).path).toBe(`/meetings/${MEETING_ID}`);
      expect((patchCall![0] as { body: string }).body).toBe(JSON.stringify({ title: "New name" }));
    });
  });

  it("does not PATCH when the title is unchanged", async () => {
    const detail = makeDetail({ title: "Same name" });
    primeFetches(detail);

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    const titleBtn = await screen.findByRole("button", { name: /Edit meeting title/i });
    fireEvent.click(titleBtn);

    const input = await screen.findByRole("textbox", { name: /Meeting title/i });
    fireEvent.keyDown(input, { key: "Enter" });

    // Give React Query a beat to resolve any stray work.
    await waitFor(() => {
      expect(mockApiJson).toHaveBeenCalledTimes(1); // GET only — no PATCH
    });
  });

  it("blocks commit and shows a FieldError above the 200-character ceiling", async () => {
    const detail = makeDetail({ title: "Short" });
    primeFetches(detail);

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    const titleBtn = await screen.findByRole("button", { name: /Edit meeting title/i });
    fireEvent.click(titleBtn);

    const input = await screen.findByRole("textbox", { name: /Meeting title/i });
    fireEvent.change(input, { target: { value: "x".repeat(201) } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(/200 characters or fewer/)).toBeInTheDocument();
    // Only the GET was issued.
    await waitFor(() => {
      expect(mockApiJson).toHaveBeenCalledTimes(1);
    });
  });
});

describe("MeetingDetailView — tag editing", () => {
  it("PATCHes with the new tag list when a tag is added via Enter", async () => {
    const detail = makeDetail({ tags: ["finance"] });
    primeFetches(detail);
    mockApiJson.mockResolvedValueOnce({
      ...detail,
      tags: ["finance", "q4"],
    });

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    const tagInput = await screen.findByRole("textbox", { name: /Add tag/i });
    fireEvent.change(tagInput, { target: { value: "q4" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    await waitFor(() => {
      const patchCall = mockApiJson.mock.calls.find(
        (c) => (c[0] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      expect((patchCall![0] as { body: string }).body).toBe(
        JSON.stringify({ tags: ["finance", "q4"] }),
      );
    });
  });

  it("PATCHes with the tag removed when the chip × is clicked", async () => {
    const detail = makeDetail({ tags: ["finance", "q4"] });
    primeFetches(detail);
    mockApiJson.mockResolvedValueOnce({ ...detail, tags: ["q4"] });

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    const removeBtn = await screen.findByRole("button", { name: /Remove tag finance/i });
    fireEvent.click(removeBtn);

    await waitFor(() => {
      const patchCall = mockApiJson.mock.calls.find(
        (c) => (c[0] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      expect((patchCall![0] as { body: string }).body).toBe(JSON.stringify({ tags: ["q4"] }));
    });
  });

  it("blocks the 11th tag with an inline error", async () => {
    const tenTags = Array.from({ length: 10 }, (_, i) => `t${i}`);
    primeFetches(makeDetail({ tags: tenTags }));

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    const tagInput = await screen.findByRole("textbox", { name: /Add tag/i });
    fireEvent.change(tagInput, { target: { value: "eleventh" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    expect(await screen.findByText(/at most 10 tags/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(mockApiJson).toHaveBeenCalledTimes(1); // GET only
    });
  });

  it("blocks tags longer than 32 characters with an inline error", async () => {
    primeFetches(makeDetail({ tags: [] }));

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    const tagInput = await screen.findByRole("textbox", { name: /Add tag/i });
    fireEvent.change(tagInput, { target: { value: "x".repeat(33) } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    expect(await screen.findByText(/32 characters or fewer/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(mockApiJson).toHaveBeenCalledTimes(1);
    });
  });

  it("silently dedupes a duplicate tag without surfacing an error", async () => {
    primeFetches(makeDetail({ tags: ["finance"] }));

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    const tagInput = await screen.findByRole("textbox", { name: /Add tag/i });
    fireEvent.change(tagInput, { target: { value: "finance" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    // Input clears, no error rendered, no PATCH issued.
    await waitFor(() => {
      expect((tagInput as HTMLInputElement).value).toBe("");
    });
    expect(screen.queryByText(/at most/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/characters or fewer/i)).not.toBeInTheDocument();
    expect(mockApiJson).toHaveBeenCalledTimes(1); // GET only
  });
});
