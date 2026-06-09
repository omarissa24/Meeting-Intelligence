/**
 * Render a playback position as a clock readout for the audio scrubber.
 *
 * Examples:
 *   `formatClock(0)     === "0:00"`
 *   `formatClock(5)     === "0:05"`
 *   `formatClock(65)    === "1:05"`
 *   `formatClock(125)   === "2:05"`
 *   `formatClock(3661)  === "1:01:01"`
 *
 * Under an hour → `m:ss` (minutes are not zero-padded). Hour-plus →
 * `h:mm:ss`. Unlike `formatDuration` (human prose for the ended-session
 * cards), this keeps seconds at every scale and is monospace-friendly so
 * the current/total readout doesn't jitter as playback advances.
 *
 * Garbage input (NaN, Infinity, negative) renders `"0:00"`.
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const pad = (n: number) => n.toString().padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(secs)}`;
  }
  return `${minutes}:${pad(secs)}`;
}
