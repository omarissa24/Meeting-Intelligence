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
 * Relative-day words come from `Intl.RelativeTimeFormat` so they follow
 * the same navigator locale as the absolute formats below — previously
 * "Today"/"Yesterday" were hardcoded English next to locale-driven
 * absolute dates, producing mixed-language rows ("Yesterday" · "ven. 5
 * juin").
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

  const dayDelta = Math.round((startOfLocalDay(now) - startOfLocalDay(d)) / DAY_MS);

  if (dayDelta === 0 || dayDelta === 1) {
    const label = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
      -dayDelta,
      "day",
    );
    return label.charAt(0).toLocaleUpperCase() + label.slice(1);
  }

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

/**
 * Render the local clock time for a meeting timestamp, e.g. `3:00 PM`.
 * Locale-driven (mirrors session-ended's `formatTimeRange`) so it follows
 * the OS 12/24-hour preference. `null` / unparseable inputs render as `—`,
 * matching {@link formatRelativeDate}. Pairs with `formatRelativeDate` in
 * the history / detail metadata rows: `Today · 3:00 PM · 45s`.
 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/**
 * Stable local-calendar-day key (`YYYY-MM-DD`) for grouping meetings by
 * day in the history list. Returns `null` for missing/unparseable input
 * so callers can bucket those rows into a trailing "Undated" group.
 * Local time on purpose — grouping must agree with what
 * {@link formatRelativeDate} renders for the same timestamp.
 */
export function formatDayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DAY_MS = 86_400_000;

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
