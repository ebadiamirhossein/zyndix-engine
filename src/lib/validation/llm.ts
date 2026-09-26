import { z } from "zod";

import {
  evidenceArraySchema,
  triggersSchema,
  visibleToolsSchema,
} from "@/lib/validation/jsonb";
import { REPLY_CLASSIFICATIONS } from "@/types/enums";

// ---------------------------------------------------------------------------
// Qualifier output (doc 04 §3)
// ---------------------------------------------------------------------------

export const RECOMMENDED_ANGLES = [
  "speed-to-lead",
  "follow-up",
  "no-show",
  "reviews",
  "onboarding",
  "reporting",
  "ai-support",
  "custom-tool",
] as const;

/**
 * Evidence text that describes a failed or missing fetch. Absence of data is
 * not evidence of absence: the qualifier may not emit such an item, and the
 * claim guard refuses a draft that cites one (`failed_crawl_evidence`).
 */
export const FAILED_FETCH_PATTERNS = [
  "unavailable",
  "failed to fetch",
  "fetch failed",
  "failed fetch",
  "we failed to fetch",
] as const;

export function describesFailedFetch(text: string): boolean {
  const lower = text.toLowerCase();
  return FAILED_FETCH_PATTERNS.some((pattern) => lower.includes(pattern));
}

export const qualifierOutputSchema = z
  .object({
    fit_score: z.number().int().min(0).max(100),
    segment: z.string().min(1),
    problem_hypothesis: z.string().nullable(),
    evidence: z.array(
      z
        .object({
          source: z.enum(["website", "linkedin", "jobs", "apollo"]),
          observation: z.string().min(1),
        })
        .strict(),
    ),
    triggers: triggersSchema,
    visible_tools: visibleToolsSchema,
    recommended_angle: z.enum(RECOMMENDED_ANGLES),
    disqualify_reason: z.string().nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    for (const [idx, item] of data.evidence.entries()) {
      if (describesFailedFetch(item.observation)) {
        ctx.addIssue({
          code: "custom",
          message:
            "evidence may not cite failed fetches / UNAVAILABLE sources (absence of data is not evidence of absence)",
          path: ["evidence", idx, "observation"],
        });
      }
    }

    if (data.disqualify_reason === null) {
      if (!data.problem_hypothesis || data.problem_hypothesis.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          message:
            "problem_hypothesis is required when disqualify_reason is null",
          path: ["problem_hypothesis"],
        });
      }
      if (data.evidence.length < 1) {
        ctx.addIssue({
          code: "custom",
          message: "evidence must contain at least one item when not disqualified",
          path: ["evidence"],
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// Writer output (doc 04 §4, doc 01 FR-6: ≤120 words)
// ---------------------------------------------------------------------------

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Claim ledger (09 §U6b). Each claim quotes its exact span from the subject or
// body; evidence ids E1…En index the lead's qualification.evidence (interim,
// until U15's typed evidence ids). The guard never trusts the kind tag.
export const CLAIM_KINDS = ["prospect_fact", "inference", "offer", "question"] as const;

export const claimSchema = z
  .object({
    span: z.string().min(1),
    kind: z.enum(CLAIM_KINDS),
    evidence_ids: z.array(z.string().regex(/^E\d+$/, "evidence ids look like E1, E2, …")),
  })
  .strict()
  .superRefine((claim, ctx) => {
    if ((claim.kind === "prospect_fact" || claim.kind === "inference") && claim.evidence_ids.length === 0) {
      ctx.addIssue({ code: "custom", message: `a ${claim.kind} claim must cite at least one evidence id`, path: ["evidence_ids"] });
    }
    if (claim.kind === "offer" && claim.evidence_ids.length > 0) {
      ctx.addIssue({ code: "custom", message: "an offer claim cites no evidence", path: ["evidence_ids"] });
    }
  });

export type Claim = z.infer<typeof claimSchema>;

export const claimLedgerSchema = z.array(claimSchema);

export const writerOutputSchema = z
  .object({
    subject: z.string().min(1),
    body: z.string().min(1),
    claims: z.array(claimSchema).min(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (wordCount(data.body) > 120) {
      ctx.addIssue({
        code: "custom",
        message: `body must be ≤120 words (got ${wordCount(data.body)})`,
        path: ["body"],
      });
    }
  });

// Writer output v10 (09 §U6c): one call writes the writer steps of the
// sequence (steps 1–2). Only step 1 has a subject: follow-ups share its
// thread, and Instantly renders their subject as "Re: <step-1 subject>".
// Which step numbers are expected comes from email_sequence, so the shape
// check (sequenceShapeIssues) is separate from this parse.
export const writerSequenceStepSchema = z
  .object({
    step_no: z.number().int().positive(),
    subject: z.string().min(1).optional(),
    body: z.string().min(1),
    claims: z.array(claimSchema).min(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (wordCount(data.body) > 120) {
      ctx.addIssue({
        code: "custom",
        message: `body must be ≤120 words (got ${wordCount(data.body)})`,
        path: ["body"],
      });
    }
  });

export const writerSequenceOutputSchema = z
  .object({
    steps: z.array(writerSequenceStepSchema).min(1),
  })
  .strict();

export type WriterSequenceStep = z.infer<typeof writerSequenceStepSchema>;
export type WriterSequenceOutput = z.infer<typeof writerSequenceOutputSchema>;

/**
 * `sequence_shape_invalid` (09 §U6c): the steps must be exactly the expected
 * writer steps, in order; step 1 carries the subject and no later step does.
 */
export function sequenceShapeIssues(output: WriterSequenceOutput, expectedSteps: number[]): string[] {
  const issues: string[] = [];
  const got = output.steps.map((s) => s.step_no);
  if (got.length !== expectedSteps.length || got.some((n, i) => n !== expectedSteps[i])) {
    issues.push(`expected steps [${expectedSteps.join(",")}], got [${got.join(",")}]`);
  }
  for (const step of output.steps) {
    if (step.step_no === 1 && !step.subject?.trim()) issues.push("step 1 must have a subject");
    if (step.step_no > 1 && step.subject !== undefined) issues.push(`step ${step.step_no} must not have a subject (it continues step 1's thread)`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Reply classifier output (doc 04 §6)
// ---------------------------------------------------------------------------

export const CLASSIFIER_SENTIMENTS = [
  "positive",
  "neutral",
  "negative",
] as const;

export const CLASSIFIER_SUGGESTED_ACTIONS = [
  "book_link",
  "answer_question",
  "handle_objection",
  "snooze_60d",
  "stop_and_suppress",
  "redirect_new_contact",
] as const;

export const replyClassifierOutputSchema = z
  .object({
    classification: z.enum(REPLY_CLASSIFICATIONS),
    sentiment: z.enum(CLASSIFIER_SENTIMENTS),
    suggested_action: z.enum(CLASSIFIER_SUGGESTED_ACTIONS),
    suggested_reply: z.string().nullable(),
    route_to_human: z.boolean(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.confidence < 0.7 && !data.route_to_human) {
      ctx.addIssue({
        code: "custom",
        message: "route_to_human must be true when confidence < 0.7",
        path: ["route_to_human"],
      });
    }
  });

// Re-export evidence schema for callers that need it standalone
export { evidenceArraySchema };
