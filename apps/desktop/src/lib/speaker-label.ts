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

/**
 * US-26: a per-meeting alias overrides the default `Speaker N` label.
 * Aliases come from `MeetingDetail.speakerAliases` — the desktop applies
 * them as a render-time overlay so transcript segments themselves stay
 * tied to the original STT label.
 *
 * `aliases` is keyed by the raw STT label (e.g. `spk-0`); a non-empty
 * trimmed value wins, otherwise we fall through to the default
 * 1-indexed label.
 */
export function displaySpeakerLabel(
  id: string,
  aliases: Record<string, string> | null | undefined,
): string {
  const alias = aliases?.[id];
  if (typeof alias === "string" && alias.trim().length > 0) {
    return alias;
  }
  return speakerLabel(id);
}
