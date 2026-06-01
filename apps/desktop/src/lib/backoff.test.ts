import { describe, expect, it } from "vitest";

import { nextDelayMs, withJitter } from "./backoff";

describe("nextDelayMs", () => {
  it("returns the documented schedule for attempts 0..6", () => {
    expect(nextDelayMs(0)).toBe(1_000);
    expect(nextDelayMs(1)).toBe(2_000);
    expect(nextDelayMs(2)).toBe(4_000);
    expect(nextDelayMs(3)).toBe(8_000);
    expect(nextDelayMs(4)).toBe(16_000);
    expect(nextDelayMs(5)).toBe(30_000);
    expect(nextDelayMs(6)).toBe(30_000);
  });

  it("caps at 30s for very large attempts", () => {
    expect(nextDelayMs(50)).toBe(30_000);
  });

  it("clamps invalid attempts to the base delay", () => {
    expect(nextDelayMs(-1)).toBe(1_000);
    expect(nextDelayMs(Number.NaN)).toBe(1_000);
  });
});

describe("withJitter", () => {
  it("stays within ±ratio of the base over many samples", () => {
    const base = 4_000;
    const ratio = 0.2;
    const lo = base * (1 - ratio);
    const hi = base * (1 + ratio);
    for (let i = 0; i < 1_000; i++) {
      const v = withJitter(base, ratio);
      expect(v).toBeGreaterThanOrEqual(lo - 1);
      expect(v).toBeLessThanOrEqual(hi + 1);
    }
  });

  it("returns the input unchanged when ratio is 0", () => {
    expect(withJitter(2_500, 0)).toBe(2_500);
  });

  it("never returns a negative value", () => {
    // Force an extreme negative offset by clamping the rng to 0 with a large ratio.
    expect(withJitter(100, 5, () => 0)).toBe(0);
  });

  it("is deterministic when given a deterministic rng", () => {
    const rand = () => 0.75;
    expect(withJitter(1_000, 0.2, rand)).toBe(withJitter(1_000, 0.2, rand));
  });
});
