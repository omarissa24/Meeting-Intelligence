/**
 * Pure dBFS → meter helpers for the live mic-level meter (US-25a).
 *
 * Kept free of React/Tauri so the band thresholds are unit-testable in
 * isolation. The component layers presentation (semantic color tokens,
 * bar widths) on top of these.
 */

/** Healthy band lower edge — below this the input is too quiet. */
export const GREEN_LOW_DBFS = -18;
/**
 * Healthy band upper edge — above this the input is getting hot. The
 * AC labels green as `-18..-6` and yellow as `>-3`; the `-6..-3` sliver
 * is unlabelled, so we treat the whole `-18..-3` span as healthy (the
 * only reading consistent with "yellow starts above -3").
 */
export const GREEN_HIGH_DBFS = -3;
/** At/above this the signal is effectively clipping (peaks pinned near 0). */
export const CLIP_DBFS = -1;
/**
 * At/below this there is essentially no input — the pipeline's silence
 * floor is -120 dBFS, so anything this quiet means "we're hearing
 * nothing useful".
 */
export const NEAR_FLOOR_DBFS = -50;

/** Lower/upper edges of the bar's drawable range (for width mapping). */
export const BAR_FLOOR_DBFS = -60;
export const BAR_CEIL_DBFS = 0;

export type LevelBand = "good" | "warn" | "bad";

/**
 * Classify a dBFS peak into a traffic-light band (US-25a AC):
 *   - `bad`  — clipping (`>= -1`) or near-floor / no input (`<= -50`)
 *   - `warn` — too quiet (`-50..-18`) or too hot (`-3..-1`)
 *   - `good` — healthy target band (`-18..-3`)
 */
export function levelBand(dbfs: number): LevelBand {
  if (dbfs >= CLIP_DBFS || dbfs <= NEAR_FLOOR_DBFS) return "bad";
  if (dbfs < GREEN_LOW_DBFS || dbfs > GREEN_HIGH_DBFS) return "warn";
  return "good";
}

/**
 * Map a dBFS peak to a 0..100 bar-fill percentage over the drawable
 * range (`-60..0` dBFS), clamped. Silence (`<= -60`) → 0; full scale
 * (`>= 0`) → 100.
 */
export function dbfsToWidthPct(dbfs: number): number {
  const span = BAR_CEIL_DBFS - BAR_FLOOR_DBFS;
  const pct = ((dbfs - BAR_FLOOR_DBFS) / span) * 100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * One-line, direction-aware hint for the meter (US-25a). Returns `null`
 * when both bands are healthy. Otherwise points the user at the OS
 * input control, tailored to whether the signal is too hot (clipping /
 * `> -3`) or too quiet. Purely informational — independent of the
 * pipeline's static gain compensation.
 */
export function levelHint(rawDbfs: number, resampledDbfs: number): string | null {
  if (levelBand(rawDbfs) === "good" && levelBand(resampledDbfs) === "good") {
    return null;
  }
  const hottest = Math.max(rawDbfs, resampledDbfs);
  if (hottest > GREEN_HIGH_DBFS) {
    return "Input is hot — lower the mic level in System Settings → Sound → Input.";
  }
  return "Low input — raise the mic level in System Settings → Sound → Input.";
}
