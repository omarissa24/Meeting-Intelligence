import { describe, expect, it } from "vitest";

import { displayMeetingTitle } from "./meeting-title";

describe("displayMeetingTitle", () => {
  it("returns the trimmed real title when one exists", () => {
    expect(displayMeetingTitle({ title: "  Quarterly review ", startedAt: null })).toEqual({
      title: "Quarterly review",
      isFallback: false,
    });
  });

  it("derives a date-based title when the title is missing", () => {
    const startedAt = "2026-06-05T16:01:00Z";
    const stamp = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(startedAt));

    expect(displayMeetingTitle({ title: null, startedAt })).toEqual({
      title: `Meeting — ${stamp}`,
      isFallback: true,
    });
  });

  it("treats whitespace-only titles as missing", () => {
    const out = displayMeetingTitle({ title: "   ", startedAt: "2026-06-05T16:01:00Z" });
    expect(out.isFallback).toBe(true);
    expect(out.title).toMatch(/^Meeting — /);
  });

  it("falls back to 'Untitled meeting' with no title and no start time", () => {
    expect(displayMeetingTitle({ title: null, startedAt: null })).toEqual({
      title: "Untitled meeting",
      isFallback: true,
    });
  });

  it("falls back to 'Untitled meeting' on unparseable start times", () => {
    expect(displayMeetingTitle({ title: null, startedAt: "not a date" }).title).toBe(
      "Untitled meeting",
    );
  });
});
