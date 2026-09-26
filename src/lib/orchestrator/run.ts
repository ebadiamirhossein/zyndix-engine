import { randomUUID } from "node:crypto";

import { assertCron, CronUnauthorizedError, unauthorizedResponse } from "@/lib/auth/cron";
import type { JobQueue } from "@/lib/jobs/queue";
import type { JobRegistry } from "@/lib/jobs/registry";
import { CLASSIFY_REPLY_JOB_TYPE, SAFETY_JOB_TYPES, type StageName } from "@/lib/jobs/types";
import { runWorker, type WorkerSummary } from "@/lib/jobs/worker";

import { readOperationsPause, readOrchestratorBudgets, type SettingReader } from "./pause";
import { partitionTypes } from "./registry";
import { bucketOf, STAGE_ORDER, stageJobType } from "./stages";

// The cron cores (09 §U9). Route files stay thin: they build production deps
// and call these. Pure apart from the injected queue/registry/settings.
//
//   orchestrate — global pause → return at once: nothing enqueued, no job
//                 run, no registry built, so no provider client exists.
//                 Else enqueue this bucket's stage jobs and drain every
//                 NON-safety type within run_budget_ms, re-reading the pause
//                 before each claim: a pause flipped mid-run stops the drain
//                 with the remaining jobs still queued (no attempt burned).
//   safety      — enqueue the three reconcile sweeps for this bucket and
//                 drain the SAFETY types within safety_budget_ms. Runs
//                 whatever the pause says: stops must stay reliable.

/** Reconcile sweeps enqueued once per 5-minute bucket by the safety cron. */
export const SWEEP_JOB_TYPES = ["reconcile.stale_stop", "reconcile.reply_poll", "reconcile.instantly_leads"] as const;

/** Headroom kept for the final job write and the response (mirrors the worker's reserve). */
const RESERVE_MS = 2_000;

export type CronDeps = {
  queue: JobQueue;
  /** Built lazily: the paused orchestrate path never constructs a provider client. */
  registry: () => JobRegistry;
  getActiveSetting: SettingReader;
  now?: () => Date;
  /** Test seams (unique job types, so a DB test never claims a real job). Never set in production. */
  stageTypes?: Record<StageName, string>;
  safetyTypes?: readonly string[];
  sweepTypes?: readonly string[];
  classifyType?: string;
};

type Counts = Pick<WorkerSummary, "claimed" | "completed" | "retried" | "dead" | "leaseLost">;

export type DrainResult = Counts & {
  failed: number;
  stoppedReason: "drained" | "budget" | "paused" | "no_types";
  byType: Record<string, number>;
};

export type OrchestrateResult =
  | { paused: true; reason: string | null; claimed: 0; completed: 0; failed: 0 }
  | ({
      paused: false;
      bucket: string;
      budgets_version: number | null;
      enqueued: Partial<Record<StageName, "enqueued" | "deduped" | "disabled" | "unregistered">>;
    } & DrainResult);

export type SafetyResult = {
  bucket: string;
  enqueued: Record<string, "enqueued" | "deduped" | "unregistered">;
  missing_safety_types: string[];
} & DrainResult;

/**
 * Runs jobs of `types` one claim at a time until the queue is empty, the
 * budget cannot fit another job, or (checkPause) the global pause is on.
 * Per claim, only the types whose timeout still fits the remaining budget are
 * eligible, so one slow type does not stop the short ones. `caps` bounds how
 * many jobs of a type run in this drain.
 */
export async function drain(
  deps: Pick<CronDeps, "queue" | "getActiveSetting">,
  registry: JobRegistry,
  options: { types: readonly string[]; budgetMs: number; checkPause: boolean; caps?: Record<string, number>; owner: string },
): Promise<DrainResult> {
  const result: DrainResult = {
    claimed: 0,
    completed: 0,
    retried: 0,
    dead: 0,
    leaseLost: 0,
    failed: 0,
    stoppedReason: "drained",
    byType: {},
  };
  if (options.types.length === 0) {
    result.stoppedReason = "no_types";
    return result;
  }
  const started = Date.now();
  let lastClaimed: string | null = null;
  const queue: JobQueue = {
    ...deps.queue,
    claim: async (input) => {
      const rows = await deps.queue.claim(input);
      lastClaimed = rows[0]?.type ?? null;
      return rows;
    },
  };

  while (true) {
    if (options.checkPause && (await readOperationsPause(deps.getActiveSetting)).global) {
      result.stoppedReason = "paused";
      break;
    }
    const remaining = options.budgetMs - (Date.now() - started);
    const capped = (t: string) => options.caps?.[t] !== undefined && (result.byType[t] ?? 0) >= options.caps[t]!;
    const open = options.types.filter((t) => !capped(t));
    if (open.length === 0) break;
    const fitting = open.filter((t) => registry.get(t)!.timeoutMs + RESERVE_MS <= remaining);
    if (fitting.length === 0) {
      result.stoppedReason = "budget";
      break;
    }

    lastClaimed = null;
    const pass = await runWorker({ queue, registry, budgetMs: remaining, types: fitting, maxJobs: 1, owner: options.owner });
    result.claimed += pass.claimed;
    result.completed += pass.completed;
    result.retried += pass.retried;
    result.dead += pass.dead;
    result.leaseLost += pass.leaseLost;
    if (lastClaimed) result.byType[lastClaimed] = (result.byType[lastClaimed] ?? 0) + 1;
    if (pass.claimed === 0) {
      // Nothing claimable among the types that fit; if some types did not
      // fit, their jobs may still be waiting — that is a budget stop.
      result.stoppedReason = pass.stoppedReason === "budget" || fitting.length < open.length ? "budget" : "drained";
      break;
    }
  }
  result.failed = result.retried + result.dead;
  return result;
}

export async function runOrchestrate(deps: CronDeps): Promise<OrchestrateResult> {
  const now = (deps.now ?? (() => new Date()))();
  const pause = await readOperationsPause(deps.getActiveSetting);
  if (pause.global) {
    console.log(`[orchestrator] globally paused (${pause.reason ?? "no reason"}): nothing enqueued, nothing run`);
    return { paused: true, reason: pause.reason, claimed: 0, completed: 0, failed: 0 };
  }

  const { budgets, version } = await readOrchestratorBudgets(deps.getActiveSetting);
  const registry = deps.registry();
  const bucket = bucketOf(now);

  const enqueued: Extract<OrchestrateResult, { paused: false }>["enqueued"] = {};
  for (const stage of STAGE_ORDER) {
    const limit = budgets.stages[stage];
    if (limit === 0) {
      enqueued[stage] = "disabled";
      continue;
    }
    const type = stageJobType(stage, deps.stageTypes);
    if (!registry.get(type)) {
      enqueued[stage] = "unregistered";
      continue;
    }
    // maxAttempts 1: a failed stage run is not retried — the next bucket's
    // job runs the stage again five minutes later.
    const { deduped } = await deps.queue.enqueue({
      type,
      payload: { bucket, limit },
      idempotencyKey: `${type}:${bucket}`,
      maxAttempts: 1,
    });
    enqueued[stage] = deduped ? "deduped" : "enqueued";
  }

  const { outreach } = partitionTypes(registry, deps.safetyTypes ?? SAFETY_JOB_TYPES);
  const classifyType = deps.classifyType ?? CLASSIFY_REPLY_JOB_TYPE;
  const types = budgets.stages.classify === 0 ? outreach.filter((t) => t !== classifyType) : outreach;
  const drained = await drain(deps, registry, {
    types,
    budgetMs: budgets.run_budget_ms,
    checkPause: true,
    caps: { [classifyType]: budgets.stages.classify },
    owner: `orchestrate-${randomUUID()}`,
  });
  return { paused: false, bucket, budgets_version: version, enqueued, ...drained };
}

export async function runSafety(deps: CronDeps): Promise<SafetyResult> {
  const now = (deps.now ?? (() => new Date()))();
  const { budgets } = await readOrchestratorBudgets(deps.getActiveSetting);
  const registry = deps.registry();
  const bucket = bucketOf(now);
  const { safety, missingSafety } = partitionTypes(registry, deps.safetyTypes ?? SAFETY_JOB_TYPES);
  if (missingSafety.length > 0) console.error(`[orchestrator] safety types not registered: ${missingSafety.join(", ")}`);

  const enqueued: SafetyResult["enqueued"] = {};
  for (const type of deps.sweepTypes ?? SWEEP_JOB_TYPES) {
    if (!registry.get(type)) {
      enqueued[type] = "unregistered";
      continue;
    }
    const { deduped } = await deps.queue.enqueue({ type, payload: {}, idempotencyKey: `${type}:${bucket}` });
    enqueued[type] = deduped ? "deduped" : "enqueued";
  }

  const drained = await drain(deps, registry, {
    types: safety,
    budgetMs: budgets.safety_budget_ms,
    checkPause: false,
    owner: `safety-${randomUUID()}`,
  });
  return { bucket, enqueued, missing_safety_types: missingSafety, ...drained };
}

/**
 * The shared route wrapper: Bearer CRON_SECRET (401 otherwise), then the run.
 * A run that throws is a 500 with no detail in the body (logs carry it).
 */
export async function handleCronRequest(req: Request, run: () => Promise<unknown>): Promise<Response> {
  try {
    assertCron(req);
  } catch (error) {
    if (error instanceof CronUnauthorizedError) return unauthorizedResponse();
    throw error;
  }
  try {
    return Response.json(await run());
  } catch (error) {
    console.error("[cron] run failed:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Run failed" }, { status: 500 });
  }
}
