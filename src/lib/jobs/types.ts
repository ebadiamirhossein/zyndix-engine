// Job type names added in Wave 1 (09 §U7, §U9, §UR). A leaf module with no
// imports, so the webhook enqueue sites, the unit modules and the worker
// registry (src/lib/orchestrator) can all import it without a cycle. The
// pre-Wave-1 types keep their constants where they were defined:
// send.email / send.reconcile (stages/send/core.ts), send.recipient_check
// (sending/recipient-check.ts), reconcile.* (reconcile/core.ts).

/** U7: classify one inbound reply. Enqueued by the reply webhook after the freeze. */
export const CLASSIFY_REPLY_JOB_TYPE = "classify.reply";

/** UR: research one company's company-level sources (reused across its contacts). */
export const RESEARCH_COMPANY_JOB_TYPE = "research.company";

/**
 * U9: one pipeline stage run, single-flight per 5-minute bucket. The stage
 * functions stay plain functions; these job types wrap them with a budget.
 */
export const STAGE_JOB_TYPES = {
  source: "stage.source",
  enrich: "stage.enrich",
  qualify: "stage.qualify",
  verify: "stage.verify",
  draft: "stage.draft",
  /** Enqueues step-1 sends for sequence-approved touches (never step ≥ 2). */
  send_enqueue: "stage.send_enqueue",
} as const;

export type StageName = keyof typeof STAGE_JOB_TYPES;

/**
 * Job types that only observe or stop outreach. They keep running while
 * operations_pause is on (Wave 1 decision, 06 §5): stops must stay reliable.
 * Literal strings, equal to the constants in their defining modules.
 */
export const SAFETY_JOB_TYPES = [
  "send.recipient_check",
  "send.reconcile",
  "reconcile.stale_stop",
  "reconcile.reply_poll",
  "reconcile.instantly_leads",
] as const;
