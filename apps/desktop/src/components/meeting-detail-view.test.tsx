import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MeetingDetail } from "@meeting-intelligence/shared-types";

const mockApiJson = vi.fn();
const mockApiFetch = vi.fn();

vi.mock("@/lib/api-client", () => ({
  apiJson: (...args: unknown[]) => mockApiJson(...args),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
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
    audioObjectKey: null,
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
  mockApiFetch.mockReset();
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

describe("MeetingDetailView — audio player (US-11)", () => {
  it("shows the 'Preparing audio…' state while the encode is in flight", async () => {
    // The encode-pending state requires `endedAt` to be within the
    // 2-min budget — otherwise the parent treats a missing key as
    // permanently-failed (cold-start gate). Stamp `endedAt` to "now"
    // so the fresh-encode branch fires.
    primeFetches(
      makeDetail({
        audioObjectKey: null,
        endedAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    expect(await screen.findByText(/Preparing audio/i)).toBeInTheDocument();
    // No <audio> rendered yet.
    expect(document.querySelector("audio")).toBeNull();
    // No /audio call issued — gated on audioObjectKey being non-null.
    expect(
      mockApiJson.mock.calls.find((c) =>
        (c[0] as { path: string }).path.endsWith("/audio"),
      ),
    ).toBeUndefined();
  });

  it("shows the neutral 'no archive' copy on cold-start when an old meeting has no audio", async () => {
    // A meeting that ended hours ago (well past the 2-min encode
    // budget) with no audio key on first paint must NOT read as
    // "Audio archive failed" — we don't know whether that meeting was
    // never encoded, or the user deleted it in a previous session.
    primeFetches(
      makeDetail({
        audioObjectKey: null,
        endedAt: "2026-06-03T15:42:00Z", // hours before the test runs
      }),
    );

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    expect(await screen.findByText(/No audio archive/i)).toBeInTheDocument();
    expect(screen.queryByText(/archive failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Preparing audio/i)).not.toBeInTheDocument();
  });

  it("shows 'Audio deleted' after the user deletes a previously-archived audio", async () => {
    const detail = makeDetail({ audioObjectKey: "meetings/u/m.mp3" });
    primeFetches(detail);
    // 1) URL fetch for the initially-ready audio.
    mockApiJson.mockResolvedValueOnce({
      audioUrl: "http://test.invalid/storage/local/sig",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    // 2) Post-delete refetch returns the row with the key nulled.
    mockApiJson.mockResolvedValue({ ...detail, audioObjectKey: null });
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: () => Promise.resolve(""),
    });

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    // Wait for the player to render the trigger (audio loaded).
    const trigger = await screen.findByRole("button", { name: /Delete audio/i });
    fireEvent.click(trigger);

    const confirmBtns = await screen.findAllByRole("button", { name: /Delete audio/i });
    const confirm = confirmBtns.find((b) => b.dataset.variant === "destructive");
    fireEvent.click(confirm!);

    // After the cache invalidation refetch lands, the player must show
    // the "Audio deleted" branch — NOT the Preparing skeleton, which
    // was the original bug (US-11 follow-up).
    expect(await screen.findByText(/Audio deleted/i)).toBeInTheDocument();
    expect(screen.queryByText(/Preparing audio/i)).not.toBeInTheDocument();
  });

  it("renders the <audio> element once an archived MP3 exists", async () => {
    const detail = makeDetail({ audioObjectKey: "meetings/u/m.mp3" });
    primeFetches(detail);
    // The player's useMeetingAudio fires a second apiJson call against
    // GET /meetings/:id/audio. Layer the URL response on top of the
    // detail mocks queued by primeFetches.
    mockApiJson.mockResolvedValueOnce({
      audioUrl: "http://test.invalid/storage/local/sig",
      expiresAt: "2099-01-01T00:00:00Z",
    });

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    // Audio element resolves once the URL fetch settles.
    await waitFor(() => {
      const audio = document.querySelector("audio");
      expect(audio).not.toBeNull();
      expect(audio?.getAttribute("src")).toBe("http://test.invalid/storage/local/sig");
    });
    expect(screen.getByRole("button", { name: /Delete audio/i })).toBeInTheDocument();
  });

  it("DELETEs the archive when the user confirms", async () => {
    const detail = makeDetail({ audioObjectKey: "meetings/u/m.mp3" });
    primeFetches(detail);
    mockApiJson.mockResolvedValueOnce({
      audioUrl: "http://test.invalid/storage/local/sig",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    // After confirm, the post-DELETE invalidation refetches the
    // detail; return it without the audio key so the UI flips back.
    mockApiJson.mockResolvedValue({ ...detail, audioObjectKey: null });
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: () => Promise.resolve(""),
    });

    renderWithQuery(<MeetingDetailView meetingId={MEETING_ID} />);

    // Wait for the player to render the trigger.
    const trigger = await screen.findByRole("button", { name: /Delete audio/i });
    fireEvent.click(trigger);

    // Confirm dialog button shares the label; pick the destructive one.
    const confirmBtns = await screen.findAllByRole("button", { name: /Delete audio/i });
    const confirm = confirmBtns.find((b) => b.dataset.variant === "destructive");
    expect(confirm).toBeTruthy();
    fireEvent.click(confirm!);

    await waitFor(() => {
      const deleteCall = mockApiFetch.mock.calls.find(
        (c) => (c[0] as { method?: string }).method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
      expect((deleteCall![0] as { path: string }).path).toBe(
        `/meetings/${MEETING_ID}/audio`,
      );
    });
  });
});
