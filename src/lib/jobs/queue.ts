import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { parseOrThrow } from "@/lib/validation";
import type { Json } from "@/types/database";
import type { DatabaseWithJobs } from "@/types/database-extensions";
import { jobStateSchema } from "@/types/enums";

type Db = SupabaseClient<DatabaseWithJobs>;

// ---------------------------------------------------------------------------
// Row shape, Zod-validated on every read (CLAUDE.md: validate every payload).
// ---------------------------------------------------------------------------

export const jobRowSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  payload: z.unknown(),
  state: jobStateSchema,
  run_after: z.string(),
  lease_owner: z.string().nullable(),
  lease_expires_at: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  last_error: z.string().nullable(),
  idempotency_key: z.string().nullable(),
  finished_at: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export type JobRow = z.infer<typeof jobRowSchema>;

/** Base error for queue storage failures (not handler failures). */
export class JobQueueError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JobQueueError";
  }
}

/** `last_error` is for humans and dashboards; a stack-sized blob helps neither. */
export const MAX_ERROR_LENGTH = 2000;

/**
 * Result of a lease-fenced write. `lease_lost` means the row is no longer held
 * by this owner at this attempt — the lease expired and another worker
 * re-claimed it, or it was cancelled. The write changed nothing.
 */
export type LeaseWriteResult = "ok" | "lease_lost";

export type EnqueueInput = {
  type: string;
  payload?: Json;
  /** ISO timestamp. Defaults to now (DB default). */
  runAfter?: string;
  maxAttempts?: number;
  idempotencyKey?: string;
};

export type ClaimInput = {
  owner: string;
  types: readonly string[];
  limit?: number;
  leaseSeconds?: number;
};

export function createJobQueue(db: Db) {
  const parseRow = (row: unknown, context: string): JobRow => parseOrThrow(jobRowSchema, row, context);

  async function get(id: string): Promise<JobRow | null> {
    const { data, error } = await db.from("jobs").select("*").eq("id", id).maybeSingle();
    if (error) {
      throw new JobQueueError(`get job ${id} failed: ${error.message}`);
    }
    return data ? parseRow(data, "jobs.get") : null;
  }

  /**
   * Insert a job. With an idempotency key, enqueueing the same logical work a
   * second time returns the existing row (`deduped: true`) — whatever state it
   * is in — rather than creating a second one.
   */
  async function enqueue(input: EnqueueInput): Promise<{ job: JobRow; deduped: boolean }> {
    const { data, error } = await db
      .from("jobs")
      .insert({
        type: input.type,
        payload: input.payload ?? {},
        ...(input.runAfter ? { run_after: input.runAfter } : {}),
        ...(input.maxAttempts ? { max_attempts: input.maxAttempts } : {}),
        idempotency_key: input.idempotencyKey ?? null,
      })
      .select("*")
      .single();

    if (!error) {
      return { job: parseRow(data, "jobs.enqueue"), deduped: false };
    }

    if (error.code === "23505" && input.idempotencyKey) {
      const existing = await db
        .from("jobs")
        .select("*")
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();
      if (existing.error || !existing.data) {
        throw new JobQueueError(
          `enqueue ${input.type}: duplicate idempotency key but existing row unreadable: ${existing.error?.message ?? "not found"}`,
        );
      }
      return { job: parseRow(existing.data, "jobs.enqueue.existing"), deduped: true };
    }

    throw new JobQueueError(`enqueue ${input.type} failed: ${error.message}`);
  }

  /** Lease runnable jobs via claim_jobs() (0006b). Disjoint across concurrent callers. */
  async function claim(input: ClaimInput): Promise<JobRow[]> {
    const { data, error } = await db.rpc("claim_jobs", {
      p_owner: input.owner,
      p_types: [...input.types],
      p_limit: input.limit ?? 1,
      p_lease_seconds: input.leaseSeconds ?? 300,
    });
    if (error) {
      throw new JobQueueError(`claim_jobs failed: ${error.message}`);
    }
    return parseOrThrow(z.array(jobRowSchema), data ?? [], "jobs.claim");
  }

  /**
   * Fenced update: applies only while this owner still holds this attempt's
   * lease. A worker that overran its lease cannot overwrite the new holder.
   */
  async function fencedUpdate(
    job: JobRow,
    owner: string,
    patch: DatabaseWithJobs["public"]["Tables"]["jobs"]["Update"],
  ): Promise<LeaseWriteResult> {
    const { data, error } = await db
      .from("jobs")
      .update(patch)
      .eq("id", job.id)
      .eq("state", "leased")
      .eq("lease_owner", owner)
      .eq("attempts", job.attempts)
      .select("id");
    if (error) {
      throw new JobQueueError(`update job ${job.id} failed: ${error.message}`);
    }
    return data && data.length === 1 ? "ok" : "lease_lost";
  }

  async function complete(job: JobRow, owner: string): Promise<LeaseWriteResult> {
    return fencedUpdate(job, owner, {
      state: "done",
      lease_owner: null,
      lease_expires_at: null,
      last_error: null,
      finished_at: new Date().toISOString(),
    });
  }

  /**
   * Record a failed attempt. Goes `dead` when the error is permanent or the
   * attempt budget is spent; otherwise back to `queued` at `runAfter`.
   */
  async function fail(
    job: JobRow,
    owner: string,
    errorMessage: string,
    options: { runAfter: string; permanent?: boolean },
  ): Promise<{ result: LeaseWriteResult; state: "queued" | "dead" }> {
    const dead = options.permanent === true || job.attempts >= job.max_attempts;
    const last_error = errorMessage.slice(0, MAX_ERROR_LENGTH);
    const result = await fencedUpdate(
      job,
      owner,
      dead
        ? { state: "dead", lease_owner: null, lease_expires_at: null, last_error, finished_at: new Date().toISOString() }
        : { state: "queued", lease_owner: null, lease_expires_at: null, last_error, run_after: options.runAfter },
    );
    return { result, state: dead ? "dead" : "queued" };
  }

  /** Cancel a job that has not started. A leased job is mid-flight and is not cancelled here. */
  async function cancel(id: string): Promise<boolean> {
    const { data, error } = await db
      .from("jobs")
      .update({ state: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", id)
      .eq("state", "queued")
      .select("id");
    if (error) {
      throw new JobQueueError(`cancel job ${id} failed: ${error.message}`);
    }
    return (data?.length ?? 0) === 1;
  }

  return { get, enqueue, claim, complete, fail, cancel };
}

export type JobQueue = ReturnType<typeof createJobQueue>;
