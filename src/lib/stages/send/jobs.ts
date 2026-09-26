import { z } from "zod";

import { defineJob, type RegisteredJob } from "@/lib/jobs/registry";
import {
  RECIPIENT_CHECK_JOB_TYPE,
  type RecipientCheckDeps,
  recipientCheckPayloadSchema,
  runRecipientCheck,
} from "@/lib/sending/recipient-check";

import {
  RECONCILE_JOB_TYPE,
  runReconcileJob,
  runSendJob,
  SEND_JOB_TYPE,
  type SendDeps,
} from "./core";

// Job definitions for the send stage (U2 registry). Pure: deps are injected,
// so scripts and tests register the same definitions against mocks.

export const sendJobPayloadSchema = z.object({ touch_id: z.string().uuid() }).strict();
export const reconcileJobPayloadSchema = z.object({ outbox_id: z.string().uuid() }).strict();

/** One provider call per run: well inside the default lease sizing. */
const SEND_TIMEOUT_MS = 45_000;

export function sendJobDefinitions(deps: SendDeps): RegisteredJob[] {
  return [
    defineJob({
      type: SEND_JOB_TYPE,
      payloadSchema: sendJobPayloadSchema,
      timeoutMs: SEND_TIMEOUT_MS,
      handler: async (job) => {
        await runSendJob(deps, job);
      },
    }),
    defineJob({
      type: RECONCILE_JOB_TYPE,
      payloadSchema: reconcileJobPayloadSchema,
      timeoutMs: SEND_TIMEOUT_MS,
      handler: async (job) => {
        await runReconcileJob(deps, job);
      },
    }),
  ];
}

/**
 * The post-send recipient check (09 §U6c scope 6). Its own deps: it reads
 * GET /emails/{id} and may stop a sequence and pause a sender, which the send
 * stage's deps deliberately cannot do.
 */
export function recipientCheckJobDefinition(deps: RecipientCheckDeps): RegisteredJob {
  return defineJob({
    type: RECIPIENT_CHECK_JOB_TYPE,
    payloadSchema: recipientCheckPayloadSchema,
    // getEmail may wait on the shared 20 req/min limiter; a stop is ≤ 2 DELETEs + reads.
    timeoutMs: 90_000,
    handler: async (job) => {
      await runRecipientCheck(deps, job);
    },
  });
}
