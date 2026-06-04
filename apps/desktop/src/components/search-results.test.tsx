import { describe, expect, it } from "vitest";

import { highlightMatches } from "./search-results";

describe("highlightMatches", () => {
  it("returns plain text when query is empty", () => {
    expect(highlightMatches("hello world", "")).toEqual([
      { text: "hello world", match: false },
    ]);
  });

  it("returns plain text when no literal match exists (semantic-only hit)", () => {
    expect(highlightMatches("budget overrun", "cost reduction")).toEqual([
      { text: "budget overrun", match: false },
    ]);
  });

  it("splits around case-insensitive literal matches", () => {
    const segs = highlightMatches(
      "We discussed Budget overruns and budget cuts.",
      "budget",
    );
    expect(segs).toEqual([
      { text: "We discussed ", match: false },
      { text: "Budget", match: true },
      { text: " overruns and ", match: false },
      { text: "budget", match: true },
      { text: " cuts.", match: false },
    ]);
  });

  it("preserves the original casing of the matched substring", () => {
    const segs = highlightMatches("Quarterly Revenue Projections", "revenue");
    expect(segs.find((s) => s.match)?.text).toBe("Revenue");
  });

  it("trims whitespace before testing for a match", () => {
    expect(highlightMatches("alpha beta", "  beta  ")[1]).toEqual({
      text: "beta",
      match: true,
    });
  });
});
