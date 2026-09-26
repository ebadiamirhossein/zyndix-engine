import { defineJob, type RegisteredJob } from "@/lib/jobs/registry";
import { CLASSIFY_REPLY_JOB_TYPE } from "@/lib/jobs/types";

import { type ClassifyDeps, classifyReplyPayloadSchema, runClassifyJob } from "./core";

// Job definition for `classify.reply` (09 §U7). Pure: deps are injected, so
// the test suite registers the same definition against mocks. The worker
// enforces the global pause before running it (U9).

export type { ClassifyDeps } from "./core";

/** Up to two model calls (each with the client's own one retry) plus a stop. */
const CLASSIFY_TIMEOUT_MS = 150_000;

/** Job definitions for `classify.reply` (CLASSIFY_REPLY_JOB_TYPE in lib/jobs/types.ts). */
export function classifyJobDefinitions(deps: ClassifyDeps): RegisteredJob[] {
  return [
    defineJob({
      type: CLASSIFY_REPLY_JOB_TYPE,
      payloadSchema: classifyReplyPayloadSchema,
      timeoutMs: CLASSIFY_TIMEOUT_MS,
      handler: async (job) => {
        await runClassifyJob(deps, { payload: job.payload, attempt: job.attempt, maxAttempts: job.maxAttempts });
      },
    }),
  ];
}
