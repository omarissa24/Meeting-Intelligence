import { describe, expect, it } from "vitest";

import { dbfsToWidthPct, levelBand, levelHint } from "./mic-level";

describe("levelBand", () => {
  it("classifies the healthy target band as good", () => {
    expect(levelBand(-18)).toBe("good"); // lower edge inclusive
    expect(levelBand(-12)).toBe("good");
    expect(levelBand(-6)).toBe("good");
    expect(levelBand(-3)).toBe("good"); // upper edge inclusive
  });

  it("classifies too-quiet (above the floor, below -18) as warn", () => {
    expect(levelBand(-19)).toBe("warn");
    expect(levelBand(-40)).toBe("warn");
    expect(levelBand(-49.9)).toBe("warn");
  });

  it("classifies too-hot (above -3, below clipping) as warn", () => {
    expect(levelBand(-2.5)).toBe("warn");
    expect(levelBand(-1.5)).toBe("warn");
  });

  it("classifies clipping as bad", () => {
    expect(levelBand(-1)).toBe("bad"); // clip edge inclusive
    expect(levelBand(-0.5)).toBe("bad");
    expect(levelBand(0)).toBe("bad");
  });

  it("classifies near-floor / no input as bad", () => {
    expect(levelBand(-50)).toBe("bad"); // floor edge inclusive
    expect(levelBand(-90)).toBe("bad");
    expect(levelBand(-120)).toBe("bad"); // pipeline silence floor
  });
});

describe("dbfsToWidthPct", () => {
  it("maps the drawable range edges to 0 and 100", () => {
    expect(dbfsToWidthPct(-60)).toBe(0);
    expect(dbfsToWidthPct(0)).toBe(100);
  });

  it("maps the midpoint to 50", () => {
    expect(dbfsToWidthPct(-30)).toBe(50);
  });

  it("clamps below the floor and above full scale", () => {
    expect(dbfsToWidthPct(-120)).toBe(0);
    expect(dbfsToWidthPct(6)).toBe(100);
  });
});

describe("levelHint", () => {
  it("returns null when both bands are healthy", () => {
    expect(levelHint(-12, -10)).toBeNull();
  });

  it("warns about a hot signal when either side is too loud or clipping", () => {
    expect(levelHint(-12, -0.5)).toMatch(/hot/i); // resampled clipping
    expect(levelHint(-2, -12)).toMatch(/hot/i); // raw too hot
  });

  it("warns about low input when the signal is too quiet or near-floor", () => {
    expect(levelHint(-30, -28)).toMatch(/low input/i);
    expect(levelHint(-120, -120)).toMatch(/low input/i);
  });
});
