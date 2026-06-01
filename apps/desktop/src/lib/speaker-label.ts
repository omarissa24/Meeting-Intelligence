/**
 * Map an STT-provider speaker ID to a human-readable label.
 *
 * Deepgram returns 0-indexed integer speaker IDs serialized as
 * `spk-N` (see backend `deepgram_nova.py:_results_to_event`); render
 * them as 1-indexed "Speaker N" so the first detected voice is
 * "Speaker 1", not "spk-0".
 *
 * Special-case `probe` for the echo provider's text_probe path. Any
 * other unknown shape falls through to the raw ID so debugging
 * surfaces are honest.
 */
const SPK_PATTERN = /^spk-(\d+)$/;
const SPECIAL: Record<string, string> = { probe: "Probe" };

export function speakerLabel(id: string): string {
  if (id in SPECIAL) return SPECIAL[id];
  const m = SPK_PATTERN.exec(id);
  if (m) return `Speaker ${parseInt(m[1], 10) + 1}`;
  return id;
}
