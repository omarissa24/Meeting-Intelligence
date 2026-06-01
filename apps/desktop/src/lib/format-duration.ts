/**
 * Render a duration in human-readable form for the session-ended view.
 *
 * Examples:
 *   `formatDuration(0)            === "0s"`
 *   `formatDuration(45_000)       === "45s"`
 *   `formatDuration(60_000)       === "1m 0s"`
 *   `formatDuration(83_000)       === "1m 23s"`
 *   `formatDuration(3_600_000)    === "1h 0m"`
 *   `formatDuration(3_661_000)    === "1h 1m"`
 *
 * Sub-minute → seconds only. Minute-to-hour → minutes + seconds.
 * Hour-plus → hours + minutes (seconds dropped — no one cares about
 * seconds at hour scale and it makes the cards line up).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
