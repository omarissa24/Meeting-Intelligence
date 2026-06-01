import { describe, expect, it } from "vitest";

import { speakerLabel } from "./speaker-label";

describe("speakerLabel", () => {
  it("renders Deepgram spk-N as 1-indexed Speaker N+1", () => {
    expect(speakerLabel("spk-0")).toBe("Speaker 1");
    expect(speakerLabel("spk-1")).toBe("Speaker 2");
    expect(speakerLabel("spk-99")).toBe("Speaker 100");
  });

  it("renders the echo probe specially", () => {
    expect(speakerLabel("probe")).toBe("Probe");
  });

  it("falls back to the raw id for unknown shapes", () => {
    expect(speakerLabel("alice")).toBe("alice");
    expect(speakerLabel("")).toBe("");
    expect(speakerLabel("spk-")).toBe("spk-");
    expect(speakerLabel("SPK-0")).toBe("SPK-0"); // case-sensitive on purpose
  });
});
