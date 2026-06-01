import type { TranscriptLine } from "@meeting-intelligence/shared-types";
import { describe, expect, it } from "vitest";

import {
  countSpeakers,
  countWords,
  renderTranscriptForClipboard,
} from "./transcript-stats";
import { SYSTEM_SPEAKER_ID } from "@/stores/transcript-store";

function line(
  speakerId: string,
  text: string,
  isFinal = true,
): TranscriptLine {
  return {
    sessionId: "sess-test",
    speakerId,
    text,
    startMs: 0,
    endMs: 0,
    isFinal,
  };
}

describe("countWords", () => {
  it("returns 0 for an empty list", () => {
    expect(countWords([])).toBe(0);
  });

  it("sums words across speech lines", () => {
    const lines = [
      line("spk-0", "hello world"),
      line("spk-0", "this is a test"),
    ];
    expect(countWords(lines)).toBe(6);
  });

  it("collapses internal and edge whitespace", () => {
    expect(countWords([line("spk-0", "  hello   world  ")])).toBe(2);
  });

  it("ignores empty / whitespace-only text", () => {
    expect(countWords([line("spk-0", ""), line("spk-0", "   ")])).toBe(0);
  });

  it("excludes system notes", () => {
    const lines = [
      line(SYSTEM_SPEAKER_ID, "Reconnected. A short gap may appear."),
      line("spk-0", "real speech"),
    ];
    expect(countWords(lines)).toBe(2);
  });

  it("excludes echo-probe lines", () => {
    expect(countWords([line("probe", "needle ignored"), line("spk-0", "kept")])).toBe(1);
  });
});

describe("countSpeakers", () => {
  it("returns 0 for an empty list", () => {
    expect(countSpeakers([])).toBe(0);
  });

  it("counts distinct speaker ids across speech lines", () => {
    const lines = [
      line("spk-0", "alice"),
      line("spk-1", "bob"),
      line("spk-0", "alice again"),
    ];
    expect(countSpeakers(lines)).toBe(2);
  });

  it("excludes system + probe speakers", () => {
    const lines = [
      line(SYSTEM_SPEAKER_ID, "system note"),
      line("probe", "echo probe"),
      line("spk-0", "real"),
    ];
    expect(countSpeakers(lines)).toBe(1);
  });
});

describe("renderTranscriptForClipboard", () => {
  it("formats speech lines as 'Speaker N: text'", () => {
    const lines = [line("spk-0", "first"), line("spk-1", "second")];
    expect(renderTranscriptForClipboard(lines)).toBe("Speaker 1: first\nSpeaker 2: second");
  });

  it("skips system notes and the probe", () => {
    const lines = [
      line("spk-0", "kept"),
      line(SYSTEM_SPEAKER_ID, "system"),
      line("probe", "probe"),
      line("spk-1", "also kept"),
    ];
    expect(renderTranscriptForClipboard(lines)).toBe("Speaker 1: kept\nSpeaker 2: also kept");
  });

  it("trims surrounding whitespace on each line", () => {
    expect(renderTranscriptForClipboard([line("spk-0", "  hi  ")])).toBe("Speaker 1: hi");
  });

  it("returns an empty string for an empty transcript", () => {
    expect(renderTranscriptForClipboard([])).toBe("");
  });
});
