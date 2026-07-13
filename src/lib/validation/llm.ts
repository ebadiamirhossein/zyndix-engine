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

export const writerOutputSchema = z
  .object({
    subject: z.string().min(1),
    body: z.string().min(1),
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
