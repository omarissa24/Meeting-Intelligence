/**
 * Render an ISO-8601 timestamp as a relative-day label suitable for
 * the meeting history list.
 *
 *   `Today`           - same calendar day (local TZ)
 *   `Yesterday`       - the local-day prior
 *   `Mon, Jun 1`      - within the last 7 days
 *   `Jun 1`           - same calendar year, older than a week
 *   `Jun 1, 2025`     - prior calendar year
 *
 * `null` / unparseable inputs render as `—` so the list doesn't blow
 * up on a meeting that crashed before `started_at` was stamped.
 *
 * The optional `now` argument is a seam for tests.
 */
export function formatRelativeDate(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";

  const startOfLocalDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayMs = 86_400_000;
  const dayDelta = Math.round((startOfLocalDay(now) - startOfLocalDay(d)) / dayMs);

  if (dayDelta === 0) return "Today";
  if (dayDelta === 1) return "Yesterday";

  const sameYear = d.getFullYear() === now.getFullYear();

  if (dayDelta > 1 && dayDelta < 7) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(d);
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}
