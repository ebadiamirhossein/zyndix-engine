import type { z } from "zod";

import type { replyClassifierOutputSchema } from "@/lib/validation/llm";
import type { ReplyPolicy } from "@/lib/validation/jsonb";
import type { ReplyPolicyAction } from "@/types/enums";

// The deterministic reply policy (09 §U7, brief §8 and §11). The model
// PROPOSES a classification; this pure function DECIDES the action from the
// versioned `reply_policy` table. REPLY_POLICY_ACTIONS has no send action, so
// whatever the model says, no decision can ever be "send" or "reply".
//
// Order (first match wins):
//   1. negotiation (price, terms, delivery commitments) → policy.negotiation;
//   2. confidence below the floor → human_review;
//   3. the class's action: wrong_person with a named referral →
//      policy.wrong_person_with_referral; ooo → snooze to the stated return
//      date when it is a valid future date, else now + ooo_default_days;
//      everything else → policy.table[classification];
//   4. the model routed to a human but step 3 chose an action that takes no
//      human (snooze, close, stop_and_suppress) → human_review.
// A plain price question is a `question` → the table (human_draft_review).

export type ReplyClassifierOutput = z.infer<typeof replyClassifierOutputSchema>;

export type PolicyDecision = {
  action: ReplyPolicyAction;
  /** ISO timestamp; set only for `snooze`. */
  nextActionAt: string | null;
  /** Machine-readable why, e.g. "table:question", "low_confidence". */
  reason: string;
};

const DAY_MS = 86_400_000;

/** Actions that put a person in front of the reply. Everything else acts without one. */
export const HUMAN_ACTIONS: ReadonlySet<ReplyPolicyAction> = new Set<ReplyPolicyAction>([
  "human_draft_review",
  "human_review",
  "hold",
  "redirect_new_contact",
]);

/** A valid calendar date strictly after today's UTC date, else null. */
export function futureReturnDate(value: string | null | undefined, now: Date): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const today = now.toISOString().slice(0, 10);
  return value > today ? value : null;
}

export function hasNamedReferral(output: ReplyClassifierOutput): boolean {
  const referral = output.referral;
  return Boolean(referral && (referral.name?.trim() || referral.email?.trim()));
}

function classAction(output: ReplyClassifierOutput, policy: ReplyPolicy, now: Date): PolicyDecision {
  if (output.classification === "wrong_person" && hasNamedReferral(output)) {
    return { action: policy.wrong_person_with_referral, nextActionAt: null, reason: "wrong_person_with_referral" };
  }
  const action = policy.table[output.classification];
  if (action === "snooze") {
    const stated = output.classification === "ooo" ? futureReturnDate(output.return_date, now) : null;
    if (stated) return { action, nextActionAt: `${stated}T00:00:00.000Z`, reason: `table:${output.classification}:return_date` };
    const until = new Date(now.getTime() + policy.ooo_default_days * DAY_MS).toISOString();
    return { action, nextActionAt: until, reason: `table:${output.classification}:default_${policy.ooo_default_days}d` };
  }
  return { action, nextActionAt: null, reason: `table:${output.classification}` };
}

export function decide(output: ReplyClassifierOutput, policy: ReplyPolicy, now: Date): PolicyDecision {
  let decision: PolicyDecision;
  if (output.negotiation === true) {
    decision = { action: policy.negotiation, nextActionAt: null, reason: "negotiation" };
  } else if (output.confidence < policy.confidence_floor) {
    return { action: "human_review", nextActionAt: null, reason: "low_confidence" };
  } else {
    decision = classAction(output, policy, now);
    if (output.route_to_human && !HUMAN_ACTIONS.has(decision.action)) {
      return { action: "human_review", nextActionAt: null, reason: `model_routed_to_human:${decision.reason}` };
    }
  }
  // excluded_drill belongs to the drill guard, never to a model answer; a
  // policy row that maps a class to it is a misconfiguration → a human.
  if (decision.action === "excluded_drill") {
    return { action: "human_review", nextActionAt: null, reason: `policy_action_not_applicable:${decision.reason}` };
  }
  if (decision.action === "snooze" && !decision.nextActionAt) {
    const until = new Date(now.getTime() + policy.ooo_default_days * DAY_MS).toISOString();
    return { ...decision, nextActionAt: until };
  }
  return decision;
}
