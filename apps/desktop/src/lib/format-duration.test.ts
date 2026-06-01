import { describe, expect, it } from "vitest";

import { formatDuration } from "./format-duration";

describe("formatDuration", () => {
  it("renders 0", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("renders sub-second as 0s", () => {
    expect(formatDuration(999)).toBe("0s");
  });

  it("renders sub-minute as just seconds", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("includes seconds at the minute boundary", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
  });

  it("renders minutes + seconds", () => {
    expect(formatDuration(83_000)).toBe("1m 23s");
  });

  it("drops seconds at the hour boundary", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(3_661_000)).toBe("1h 1m");
  });

  it("survives garbage input gracefully", () => {
    expect(formatDuration(Number.NaN)).toBe("0s");
    expect(formatDuration(-1)).toBe("0s");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});
