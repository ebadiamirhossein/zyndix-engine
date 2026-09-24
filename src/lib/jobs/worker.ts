import { randomUUID } from "node:crypto";

import { computeBackoffMs, nextRunAfter, type BackoffFn } from "./backoff";
import type { JobQueue, JobRow } from "./queue";
import { PermanentJobError, type JobRegistry } from "./registry";

/**
 * Worker runtime (09 §U2). One call = one bounded pass over the queue, sized to
 * fit inside a cron invocation's platform timeout:
 *
 *   loop:
 *     stop if the remaining wall-clock budget cannot fit the next job's timeout
 *     claim ONE runnable job of a registered type (lease = timeout + margin)
 *     run its handler with an AbortSignal that fires at the timeout
 *     success → done · throw → queued with backoff, or dead when out of attempts
 *     PermanentJobError / invalid payload → dead immediately
 *
 * Claiming one job at a time means a budget stop never strands a job that was
 * leased but not started. A crash mid-handler leaves the lease to expire, after
 * which claim_jobs() hands the same row (same idempotency_key) to the next
 * worker — handlers must therefore be idempotent on that key.
 */

export type WorkerOptions = {
  queue: JobQueue;
  registry: JobRegistry;
  /** Wall-clock budget for the whole pass. Must sit below the platform timeout. */
  budgetMs: number;
  /** Headroom kept back for the final complete/fail write and the response. */
  reserveMs?: number;
  /** Lease = handler timeout + this margin, so a slow write never loses a live lease. */
  leaseMarginMs?: number;
  /** Stable per pass; defaults to a random id. Fences every write this pass makes. */
  owner?: string;
  /** Restrict this pass to a subset of the registered types. */
  types?: readonly string[];
  /** Hard cap on jobs handled in one pass. */
  maxJobs?: number;
  backoff?: BackoffFn;
  now?: () => Date;
};

export type WorkerSummary = {
  owner: string;
  claimed: number;
  completed: number;
  /** Failed and re-queued for retry. */
  retried: number;
  dead: number;
  /** Finished work whose lease had already been taken by another worker. */
  leaseLost: number;
  stoppedReason: "drained" | "budget" | "max_jobs";
  elapsedMs: number;
};

const DEFAULT_RESERVE_MS = 2_000;
const DEFAULT_LEASE_MARGIN_MS = 30_000;

export class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`job_timeout: handler exceeded ${timeoutMs}ms`);
    this.name = "JobTimeoutError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/** Runs the handler, rejecting at `timeoutMs` and aborting its signal. */
async function runWithTimeout(
  run: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JobTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runWorker(options: WorkerOptions): Promise<WorkerSummary> {
  const {
    queue,
    registry,
    budgetMs,
    reserveMs = DEFAULT_RESERVE_MS,
    leaseMarginMs = DEFAULT_LEASE_MARGIN_MS,
    owner = `worker-${randomUUID()}`,
    maxJobs = Number.POSITIVE_INFINITY,
    backoff = (attempt: number) => computeBackoffMs(attempt),
    now = () => new Date(),
  } = options;

  const types = options.types ? [...options.types] : registry.types();
  for (const type of types) {
    if (!registry.get(type)) {
      throw new Error(`runWorker: type ${type} has no registered handler`);
    }
  }

  const summary: WorkerSummary = {
    owner,
    claimed: 0,
    completed: 0,
    retried: 0,
    dead: 0,
    leaseLost: 0,
    stoppedReason: "drained",
    elapsedMs: 0,
  };

  const started = Date.now();
  const remaining = () => budgetMs - (Date.now() - started);

  if (types.length === 0) {
    return summary;
  }

  // The worker does not know which type it will claim next, so it only starts
  // a claim when the slowest eligible handler would still fit.
  const worstTimeoutMs = Math.max(...types.map((type) => registry.get(type)!.timeoutMs));
  const leaseSeconds = Math.ceil((worstTimeoutMs + leaseMarginMs) / 1000);

  while (true) {
    if (summary.claimed >= maxJobs) {
      summary.stoppedReason = "max_jobs";
      break;
    }
    if (remaining() < worstTimeoutMs + reserveMs) {
      summary.stoppedReason = "budget";
      break;
    }

    const [job] = await queue.claim({ owner, types, limit: 1, leaseSeconds });
    if (!job) {
      summary.stoppedReason = "drained";
      break;
    }
    summary.claimed += 1;

    await handleOne(job);
  }

  summary.elapsedMs = Date.now() - started;
  return summary;

  async function handleOne(job: JobRow): Promise<void> {
    const definition = registry.get(job.type)!;
    try {
      await runWithTimeout(
        (signal) =>
          definition.run(
            {
              id: job.id,
              type: job.type,
              payload: job.payload,
              attempt: job.attempts,
              maxAttempts: job.max_attempts,
              idempotencyKey: job.idempotency_key,
            },
            { signal },
          ),
        definition.timeoutMs,
      );
    } catch (error: unknown) {
      const outcome = await queue.fail(job, owner, errorMessage(error), {
        permanent: error instanceof PermanentJobError,
        runAfter: nextRunAfter(now(), backoff(job.attempts)),
      });
      if (outcome.result === "lease_lost") {
        summary.leaseLost += 1;
      } else if (outcome.state === "dead") {
        summary.dead += 1;
      } else {
        summary.retried += 1;
      }
      return;
    }

    const result = await queue.complete(job, owner);
    if (result === "lease_lost") {
      summary.leaseLost += 1;
    } else {
      summary.completed += 1;
    }
  }
}
