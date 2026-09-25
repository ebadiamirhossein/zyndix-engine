// Client-side spacing for provider endpoints with a documented per-minute
// limit. GET /api/v2/emails is limited to 20 requests/min (Instantly OpenAPI,
// read 2026-09-25), so calls are spaced ≥ 60s/20 apart plus a small margin.
//
// Per-process only: two processes do not share the spacing. U9 runs a single
// worker; a 429 is still handled by the caller (reconcile ends the run and
// resumes on the next tick). Calls are serialized, so concurrent callers in
// one process queue behind each other instead of bursting.

export type RateLimiter = {
  /** Resolves when the caller may make its request. */
  take(): Promise<void>;
};

export type SpacingLimiterOptions = {
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function createSpacingLimiter(options: SpacingLimiterOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  return {
    take() {
      const turn = chain.then(async () => {
        if (last !== null) {
          const wait = last + options.minIntervalMs - now();
          if (wait > 0) await sleep(wait);
        }
        last = now();
      });
      // A rejected sleep must not wedge the queue for later callers.
      chain = turn.catch(() => undefined);
      return turn;
    },
  };
}

/** 20 req/min → one every 3,000 ms; 50 ms margin for clock skew. */
export const INSTANTLY_EMAILS_MIN_INTERVAL_MS = 3_050;

/** Shared by every Instantly client in this process (send.reconcile and the reply poll). */
export const instantlyEmailsLimiter: RateLimiter = createSpacingLimiter({
  minIntervalMs: INSTANTLY_EMAILS_MIN_INTERVAL_MS,
});
