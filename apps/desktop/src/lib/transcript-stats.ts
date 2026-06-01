import type { TranscriptLine } from "@meeting-intelligence/shared-types";

import { speakerLabel } from "@/lib/speaker-label";
import { SYSTEM_SPEAKER_ID } from "@/stores/transcript-store";

/**
 * Speaker IDs we don't count toward "real" speech: the in-app system
 * notes (reconnect banners, auto-stop sentinels) and the echo-provider
 * probe (only present in dev sessions against the in-memory STT).
 */
const NON_SPEECH_SPEAKERS = new Set<string>([SYSTEM_SPEAKER_ID, "probe"]);

function isSpeech(line: TranscriptLine): boolean {
  return !NON_SPEECH_SPEAKERS.has(line.speakerId);
}

/**
 * Approximate word count across all speech lines. Whitespace-collapsed:
 * `"hello   world"` → 2. Empty / whitespace-only text contributes 0.
 */
export function countWords(lines: TranscriptLine[]): number {
  let total = 0;
  for (const line of lines) {
    if (!isSpeech(line)) continue;
    const trimmed = line.text.trim();
    if (!trimmed) continue;
    total += trimmed.split(/\s+/).length;
  }
  return total;
}

/**
 * Distinct speaker count across speech lines. The probe and system
 * speakers are excluded.
 */
export function countSpeakers(lines: TranscriptLine[]): number {
  const set = new Set<string>();
  for (const line of lines) {
    if (!isSpeech(line)) continue;
    set.add(line.speakerId);
  }
  return set.size;
}

/**
 * Render the transcript as plain text suitable for the clipboard.
 * Format: `Speaker N: text` per line, system notes excluded. Final
 * lines only? No — interim lines are already deduplicated against
 * their finals at the store level, so we copy whatever's in the array.
 */
export function renderTranscriptForClipboard(lines: TranscriptLine[]): string {
  return lines
    .filter(isSpeech)
    .map((line) => `${speakerLabel(line.speakerId)}: ${line.text.trim()}`)
    .join("\n");
}
