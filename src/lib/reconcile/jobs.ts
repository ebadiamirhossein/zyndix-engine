import { z } from "zod";

import { defineJob, type RegisteredJob } from "@/lib/jobs/registry";

import {
  INSTANTLY_LEADS_JOB_TYPE,
  REPLY_POLL_JOB_TYPE,
  type ReconcileDeps,
  runInstantlyLeadSweep,
  runReplyPoll,
  runStaleStopCheck,
  STALE_STOP_JOB_TYPE,
} from "./core";

// Job definitions for reconciliation (U2 registry). Pure: deps are injected.
// Nothing enqueues these until U9 puts them on cron.

export const reconcileSweepPayloadSchema = z.object({}).strict();

/** The poll may wait out the 20 req/min spacing up to 10 times (~31 s). */
const RECONCILE_TIMEOUT_MS = 120_000;

export function reconcileJobDefinitions(deps: ReconcileDeps): RegisteredJob[] {
  return [
    defineJob({
      type: STALE_STOP_JOB_TYPE,
      payloadSchema: reconcileSweepPayloadSchema,
      timeoutMs: RECONCILE_TIMEOUT_MS,
      handler: async () => {
        await runStaleStopCheck(deps);
      },
    }),
    defineJob({
      type: REPLY_POLL_JOB_TYPE,
      payloadSchema: reconcileSweepPayloadSchema,
      timeoutMs: RECONCILE_TIMEOUT_MS,
      handler: async () => {
        await runReplyPoll(deps);
      },
    }),
    defineJob({
      type: INSTANTLY_LEADS_JOB_TYPE,
      payloadSchema: reconcileSweepPayloadSchema,
      timeoutMs: RECONCILE_TIMEOUT_MS,
      handler: async () => {
        await runInstantlyLeadSweep(deps);
      },
    }),
  ];
}
