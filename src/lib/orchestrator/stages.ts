import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { defineJob, type RegisteredJob } from "@/lib/jobs/registry";
import { STAGE_JOB_TYPES, type StageName } from "@/lib/jobs/types";
import type { DatabaseWithJobs } from "@/types/database-extensions";

import type { PauseState } from "./pause";

// Stage jobs (09 §U9). Each `stage.*` job wraps one plain stage function with
// the batch limit orchestrator_budgets gave it at enqueue time. The stage
// functions themselves stay plain functions; scripts still call them directly.
//
// Single-flight, twice over (Vercel: "Cron delivery can also occasionally
// invoke the same scheduled run more than once", and a long run can overlap
// the next invocation):
//   1. enqueue — idempotency key `<type>:<5-minute bucket>`, so a duplicated
//      or overlapping cron run dedupes onto the same row;
//   2. run — a stage job that finds another job of its type holding a live
//      lease completes without running the stage.
// A stage job also completes without running when the global pause is on or
// when its bucket is stale (a queued job left over from an earlier tick).

/** Stage order within one orchestrate tick. */
export const STAGE_ORDER: readonly StageName[] = ["source", "enrich", "qualify", "verify", "draft", "send_enqueue"];

export const BUCKET_MS = 5 * 60_000;
/** A stage job older than this is skipped: a newer bucket's job does the work. */
const STALE_BUCKET_MS = 2 * BUCKET_MS;

/**
 * Upper bound on one stage run. The stage functions do not observe the abort
 * signal, so these are sized for `limit` ≈ the seed budgets; raising a limit
 * far above the seed needs a matching look at these.
 */
export const STAGE_TIMEOUT_MS: Record<StageName, number> = {
  source: 90_000,
  enrich: 180_000,
  qualify: 150_000,
  verify: 60_000,
  draft: 150_000,
  send_enqueue: 30_000,
};

export const stageJobPayloadSchema = z
  .object({
    /** ISO start of the 5-minute bucket this job was enqueued for. */
    bucket: z.string().datetime(),
    /** orchestrator_budgets.stages.<name> at enqueue time; 0 is never enqueued. */
    limit: z.number().int().min(1).max(500),
  })
  .strict();

export type StageJobPayload = z.infer<typeof stageJobPayloadSchema>;

/** Runs one stage with a batch limit. Production passes the facades (sourceStage, …). */
export type StageRunner = (options: { limit: number }) => Promise<unknown>;

export type StageJobDeps = {
  runners: Record<StageName, StageRunner>;
  /** Jobs of `type`, other than `excludeId`, holding an unexpired lease. */
  countLeased: (type: string, excludeId: string) => Promise<number>;
  readPause: () => Promise<PauseState>;
  /** Test seam: job type per stage. Never set in production wiring. */
  types?: Record<StageName, string>;
  now?: () => Date;
};

export type StageJobOutcome =
  | { stage: StageName; outcome: "ran"; limit: number; summary: unknown }
  | { stage: StageName; outcome: "skipped"; reason: "paused" | "stale_bucket" | "already_running" };

/** The start of the 5-minute UTC bucket containing `now`. */
export function bucketOf(now: Date): string {
  return new Date(Math.floor(now.getTime() / BUCKET_MS) * BUCKET_MS).toISOString();
}

export function stageJobType(stage: StageName, types?: Record<StageName, string>): string {
  return (types ?? STAGE_JOB_TYPES)[stage];
}

export async function runStageJob(
  deps: StageJobDeps,
  stage: StageName,
  job: { id: string; type: string; payload: StageJobPayload },
): Promise<StageJobOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const pause = await deps.readPause();
  if (pause.global) return { stage, outcome: "skipped", reason: "paused" };
  if (now.getTime() - Date.parse(job.payload.bucket) > STALE_BUCKET_MS) {
    return { stage, outcome: "skipped", reason: "stale_bucket" };
  }
  if ((await deps.countLeased(job.type, job.id)) > 0) return { stage, outcome: "skipped", reason: "already_running" };
  const summary = await deps.runners[stage]({ limit: job.payload.limit });
  return { stage, outcome: "ran", limit: job.payload.limit, summary };
}

export function stageJobDefinitions(deps: StageJobDeps): RegisteredJob[] {
  return STAGE_ORDER.map((stage) =>
    defineJob({
      type: stageJobType(stage, deps.types),
      payloadSchema: stageJobPayloadSchema,
      timeoutMs: STAGE_TIMEOUT_MS[stage],
      handler: async (job) => {
        const outcome = await runStageJob(deps, stage, job);
        console.log(`[orchestrator] ${job.type} ${job.payload.bucket}: ${JSON.stringify(outcome)}`);
      },
    }),
  );
}

/** Production countLeased: the jobs table, read directly (queue.ts has no such query). */
export function createLeaseProbe(db: SupabaseClient<DatabaseWithJobs>): StageJobDeps["countLeased"] {
  return async (type, excludeId) => {
    const { count, error } = await db
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("type", type)
      .eq("state", "leased")
      .neq("id", excludeId)
      .gt("lease_expires_at", new Date().toISOString());
    if (error) throw new Error(`lease probe ${type}: ${error.message}`);
    return count ?? 0;
  };
}
