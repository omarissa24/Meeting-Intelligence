import { describe, expect, it } from "vitest";

import {
  appendFilterParams,
  normaliseFilters,
} from "./use-meetings-list";

describe("normaliseFilters", () => {
  it("returns an empty object for undefined input", () => {
    expect(normaliseFilters(undefined)).toEqual({});
  });

  it("drops empty strings and null values", () => {
    expect(
      normaliseFilters({
        dateStart: "",
        dateEnd: null,
        durationMinSeconds: null,
        durationMaxSeconds: null,
        tags: [],
      }),
    ).toEqual({});
  });

  it("preserves non-empty fields and sorts/dedups tags", () => {
    expect(
      normaliseFilters({
        dateStart: "2026-01-01",
        durationMinSeconds: 60,
        tags: ["b", "a", "b"],
      }),
    ).toEqual({
      dateStart: "2026-01-01",
      durationMinSeconds: 60,
      tags: ["a", "b"],
    });
  });

  it("rejects non-finite duration values", () => {
    expect(
      normaliseFilters({
        durationMinSeconds: Number.NaN,
        durationMaxSeconds: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({});
  });

  it("yields a stable key for tag-order permutations", () => {
    const a = normaliseFilters({ tags: ["foo", "bar"] });
    const b = normaliseFilters({ tags: ["bar", "foo"] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("appendFilterParams", () => {
  it("encodes scalar fields and repeats tags", () => {
    const params = new URLSearchParams();
    appendFilterParams(params, {
      dateStart: "2026-01-01",
      dateEnd: "2026-01-31",
      durationMinSeconds: 60,
      durationMaxSeconds: 3600,
      tags: ["alpha", "beta"],
    });
    expect(params.get("date_start")).toBe("2026-01-01");
    expect(params.get("date_end")).toBe("2026-01-31");
    expect(params.get("duration_min_seconds")).toBe("60");
    expect(params.get("duration_max_seconds")).toBe("3600");
    expect(params.getAll("tags")).toEqual(["alpha", "beta"]);
  });

  it("emits nothing for an empty filter object", () => {
    const params = new URLSearchParams();
    appendFilterParams(params, {});
    expect(params.toString()).toBe("");
  });
});
