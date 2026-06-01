/**
 * Exponential backoff schedule for the reconnecting WS client.
 *
 * Schedule: 1s, 2s, 4s, 8s, 16s, then capped at 30s. The 5-minute
 * total budget is enforced by the caller (reconnecting-ws-client),
 * not here — this module only computes per-attempt delays.
 */

const BASE_MS = 1000;
const MAX_MS = 30_000;

export function nextDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return BASE_MS;
  const exp = BASE_MS * 2 ** attempt;
  return Math.min(exp, MAX_MS);
}

/**
 * Apply ±ratio jitter to a base delay so a fleet of clients
 * reconnecting after a backend bounce doesn't synchronize. Default
 * ratio is 0.2 (±20%). Pass ratio=0 to get a deterministic delay
 * for tests.
 */
export function withJitter(ms: number, ratio = 0.2, rand: () => number = Math.random): number {
  if (ratio <= 0) return ms;
  const span = ms * ratio;
  const offset = (rand() * 2 - 1) * span;
  return Math.max(0, Math.round(ms + offset));
}
