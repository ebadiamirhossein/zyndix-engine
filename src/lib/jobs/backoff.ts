/**
 * Capped exponential backoff with symmetric jitter (09 §U2). Pure.
 *
 * delay(attempt) = min(maxMs, baseMs * factor^(attempt-1)) * (1 ± jitter)
 *
 * `attempt` is the attempt that just failed, 1-based — the value of
 * `jobs.attempts` after claim_jobs() incremented it. The jittered result is
 * clamped to [0, maxMs], so the cap is a real ceiling, not a centre point.
 */

export type BackoffOptions = {
  baseMs: number;
  factor: number;
  maxMs: number;
  /** Fraction of the delay, 0..1. 0.2 = ±20%. */
  jitter: number;
};

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 30_000,
  factor: 2,
  maxMs: 60 * 60_000,
  jitter: 0.2,
};

/** A backoff policy: failed attempt number → delay in ms. Injected into the worker. */
export type BackoffFn = (attempt: number) => number;

export function computeBackoffMs(
  attempt: number,
  options: Partial<BackoffOptions> = {},
  random: () => number = Math.random,
): number {
  const { baseMs, factor, maxMs, jitter } = { ...DEFAULT_BACKOFF, ...options };
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(maxMs, baseMs * Math.pow(factor, n - 1));
  const spread = raw * jitter * (2 * random() - 1);
  return Math.round(Math.min(maxMs, Math.max(0, raw + spread)));
}

export function nextRunAfter(now: Date, delayMs: number): string {
  return new Date(now.getTime() + delayMs).toISOString();
}
