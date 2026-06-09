import { describe, expect, it } from "vitest";

import { formatClock } from "./format-clock";

describe("formatClock", () => {
  it("renders 0 as 0:00", () => {
    expect(formatClock(0)).toBe("0:00");
  });

  it("zero-pads seconds under ten", () => {
    expect(formatClock(5)).toBe("0:05");
  });

  it("renders minutes + seconds without padding the minutes", () => {
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(125)).toBe("2:05");
  });

  it("floors fractional seconds", () => {
    expect(formatClock(65.9)).toBe("1:05");
  });

  it("switches to h:mm:ss at the hour boundary", () => {
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3661)).toBe("1:01:01");
  });

  it("survives garbage input gracefully", () => {
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});
