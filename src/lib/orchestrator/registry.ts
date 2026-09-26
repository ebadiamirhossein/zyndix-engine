import { createRegistry, type JobRegistry, type RegisteredJob } from "@/lib/jobs/registry";
import { SAFETY_JOB_TYPES } from "@/lib/jobs/types";

// The central job registry (09 §U9). Every job type the engine runs is
// registered here, from its unit's own definition function, so the worker
// can claim it. Pure: the groups are injected — production passes the
// server-only wiring (orchestrator/server.ts), tests pass mocks.

export type JobGroups = {
  /** send.email, send.reconcile, send.recipient_check (stages/send.ts sendJobs()). */
  send: readonly RegisteredJob[];
  /** reconcile.stale_stop, reconcile.reply_poll, reconcile.instantly_leads (reconcile.ts). */
  reconcile: readonly RegisteredJob[];
  /** classify.reply (U7, stages/classify.ts). */
  classify: readonly RegisteredJob[];
  /** research.company (UR, research.ts). */
  research: readonly RegisteredJob[];
  /** stage.* (orchestrator/stages.ts). */
  stages: readonly RegisteredJob[];
};

/** Throws DuplicateJobTypeError if two units register the same type. */
export function buildJobRegistry(groups: JobGroups): JobRegistry {
  return createRegistry([...groups.send, ...groups.reconcile, ...groups.classify, ...groups.research, ...groups.stages]);
}

/**
 * Splits the registered types by the Wave 1 pause decision (06 §5): safety
 * types only observe or stop and keep running under the global pause; every
 * other type creates or advances outreach and does not. A safety type that is
 * not registered is reported, never silently dropped.
 */
export function partitionTypes(
  registry: JobRegistry,
  safetyTypes: readonly string[] = SAFETY_JOB_TYPES,
): { safety: string[]; outreach: string[]; missingSafety: string[] } {
  const registered = registry.types();
  return {
    safety: registered.filter((t) => safetyTypes.includes(t)),
    outreach: registered.filter((t) => !safetyTypes.includes(t)),
    missingSafety: safetyTypes.filter((t) => !registered.includes(t)),
  };
}
