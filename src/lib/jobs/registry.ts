import type { z } from "zod";

/**
 * Job handler registry (09 §U2). A job type is a name, a Zod payload schema and
 * a handler. The worker claims only the types registered here, so a row whose
 * type has no handler is never leased by a worker that cannot run it.
 */

export type JobContext<P> = {
  id: string;
  type: string;
  payload: P;
  /** 1-based; the value of jobs.attempts after this claim. */
  attempt: number;
  maxAttempts: number;
  /**
   * Stable across retries and lease re-claims. Handlers that call providers
   * pass it through as the provider-side idempotency key, so a crash after
   * acceptance cannot produce a second effect.
   */
  idempotencyKey: string | null;
};

export type JobHandler<P> = (job: JobContext<P>, ctx: { signal: AbortSignal }) => Promise<void>;

export type JobDefinition<P = unknown> = {
  type: string;
  payloadSchema: z.ZodType<P>;
  handler: JobHandler<P>;
  /**
   * Upper bound on one handler run. The worker aborts `signal` at this point,
   * sizes the lease from it, and refuses to start the job if less than this
   * remains of its wall-clock budget.
   */
  timeoutMs?: number;
};

export const DEFAULT_JOB_TIMEOUT_MS = 60_000;

/**
 * Thrown by a handler to say "retrying cannot help" (bad input, a provider's
 * permanent 4xx). The job goes straight to `dead` instead of backing off.
 */
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}

export class DuplicateJobTypeError extends Error {
  constructor(type: string) {
    super(`Job type registered twice: ${type}`);
    this.name = "DuplicateJobTypeError";
  }
}

/**
 * A registered job type with its payload type erased. `run` Zod-parses the raw
 * payload before the handler sees it; a payload that fails the schema throws
 * PermanentJobError (`invalid_payload: …`) — retrying the same bytes cannot help.
 */
export type RegisteredJob = {
  type: string;
  timeoutMs: number;
  run(job: JobContext<unknown>, ctx: { signal: AbortSignal }): Promise<void>;
};

export function defineJob<P>(definition: JobDefinition<P>): RegisteredJob {
  return {
    type: definition.type,
    timeoutMs: definition.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
    async run(job, ctx) {
      const parsed = definition.payloadSchema.safeParse(job.payload);
      if (!parsed.success) {
        throw new PermanentJobError(`invalid_payload: ${JSON.stringify(parsed.error.flatten())}`);
      }
      await definition.handler({ ...job, payload: parsed.data }, ctx);
    },
  };
}

export type JobRegistry = {
  get(type: string): RegisteredJob | undefined;
  types(): string[];
};

export function createRegistry(definitions: readonly RegisteredJob[]): JobRegistry {
  const byType = new Map<string, RegisteredJob>();
  for (const definition of definitions) {
    if (byType.has(definition.type)) {
      throw new DuplicateJobTypeError(definition.type);
    }
    byType.set(definition.type, definition);
  }
  return {
    get: (type) => byType.get(type),
    types: () => [...byType.keys()],
  };
}
