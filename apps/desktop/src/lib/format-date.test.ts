import { describe, expect, it } from "vitest";

import { formatRelativeDate } from "./format-date";

describe("formatRelativeDate", () => {
  const reference = new Date(2026, 5, 3, 12, 0, 0); // 2026-06-03 local

  it("returns Today for a same-day timestamp", () => {
    const sameDay = new Date(2026, 5, 3, 8, 30, 0);
    expect(formatRelativeDate(sameDay.toISOString(), reference)).toBe("Today");
  });

  it("returns Yesterday for the prior day", () => {
    const yesterday = new Date(2026, 5, 2, 23, 0, 0);
    expect(formatRelativeDate(yesterday.toISOString(), reference)).toBe("Yesterday");
  });

  it("renders an abbreviated weekday for last week", () => {
    const fourDaysAgo = new Date(2026, 4, 30, 9, 0, 0);
    const out = formatRelativeDate(fourDaysAgo.toISOString(), reference);
    // Locale-dependent — we just guarantee the output starts with the
    // weekday abbreviation rather than the bare month so we don't
    // accidentally land on the >7-day branch.
    expect(out).toMatch(/^[A-Za-z]{3},/);
  });

  it("drops the year when the date is in the same calendar year", () => {
    const lastMonth = new Date(2026, 1, 14, 9, 0, 0);
    const out = formatRelativeDate(lastMonth.toISOString(), reference);
    expect(out).not.toMatch(/2026/);
  });

  it("includes the year for prior calendar years", () => {
    const lastYear = new Date(2025, 7, 1, 9, 0, 0);
    const out = formatRelativeDate(lastYear.toISOString(), reference);
    expect(out).toMatch(/2025/);
  });

  it("returns the em-dash for null / unparseable input", () => {
    expect(formatRelativeDate(null)).toBe("—");
    expect(formatRelativeDate(undefined)).toBe("—");
    expect(formatRelativeDate("not a date")).toBe("—");
  });
});
