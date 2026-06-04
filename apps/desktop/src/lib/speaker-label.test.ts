import { describe, expect, it } from "vitest";

import { displaySpeakerLabel, speakerLabel } from "./speaker-label";

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

describe("displaySpeakerLabel", () => {
  it("returns the alias when one is set", () => {
    expect(displaySpeakerLabel("spk-0", { "spk-0": "Omar" })).toBe("Omar");
  });

  it("falls back to the default 1-indexed label when no alias matches", () => {
    expect(displaySpeakerLabel("spk-1", { "spk-0": "Omar" })).toBe("Speaker 2");
    expect(displaySpeakerLabel("spk-0", {})).toBe("Speaker 1");
  });

  it("treats empty / whitespace aliases as no alias", () => {
    expect(displaySpeakerLabel("spk-0", { "spk-0": "" })).toBe("Speaker 1");
    expect(displaySpeakerLabel("spk-0", { "spk-0": "   " })).toBe("Speaker 1");
  });

  it("tolerates null / undefined alias maps", () => {
    expect(displaySpeakerLabel("spk-0", null)).toBe("Speaker 1");
    expect(displaySpeakerLabel("spk-0", undefined)).toBe("Speaker 1");
  });
});
