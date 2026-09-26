// Email sequence drafting rules (09 §U6c). Pure: no model, no I/O.
//
// A sequence is the steps of the active email_sequence setting. Writer steps
// (1–2) come from one writer call; template steps (3) from followup_templates.
// The claim guard runs on EVERY step, identically at draft and at approval:
//   - step 1 with its subject; later steps with subject "" (their subject is
//     step 1's, already checked, rendered "Re: …" by Instantly);
//   - template steps in template mode (no `no_cited_evidence` requirement,
//     every other rule applies);
//   - per-step freshness: evidence age + the step's cumulative delay must
//     stay within evidence_policy.max_age_days (operator, Session 17).

import type { z } from "zod";

import { cumulativeOffsetDays, type EmailSequence } from "@/lib/sending/sequence-approval";
import type { Claim } from "@/lib/validation/llm";
import type { followupTemplatesSchema } from "@/lib/validation/jsonb";

import { formatViolations, type ClaimViolation } from "./claims";
import { runClaimCheck, type ClaimContext } from "./claims-context";

export type FollowupTemplates = z.infer<typeof followupTemplatesSchema>;

export type SequenceStepDraft = {
  step_no: number;
  source: "writer" | "template";
  /** Step 1 only; null for follow-ups. */
  subject: string | null;
  /** Body as it will be approved (the compliance footer may be appended). */
  body: string;
  claims: Claim[];
};

export type StepViolations = { step: number; violations: ClaimViolation[] };

export type SequenceCheckResult = { ok: true } | { ok: false; failures: StepViolations[] };

/** The writer steps of a sequence, in order (e.g. [1, 2]). */
export function writerStepNos(sequence: EmailSequence): number[] {
  return sequence.steps.filter((s) => s.source === "writer").map((s) => s.step_no);
}

/**
 * Checks that every template step has exactly one template. A mismatch is a
 * configuration error: the draft stage refuses to run before touching a lead.
 */
export function sequenceConfigIssues(sequence: EmailSequence, templates: FollowupTemplates): string[] {
  const issues: string[] = [];
  for (const step of sequence.steps.filter((s) => s.source === "template")) {
    if (!templates.templates.some((t) => t.step_no === step.step_no)) {
      issues.push(`email_sequence step ${step.step_no} is a template step but followup_templates has no template for it`);
    }
  }
  return issues;
}

/** Fills {first_name}. Null when a used variable has no value (never "Hi ,"). */
export function renderFollowupTemplate(body: string, vars: { first_name: string | null }): string | null {
  if (body.includes("{first_name}")) {
    const name = (vars.first_name ?? "").trim();
    if (!name) return null;
    return body.replace(/\{first_name\}/g, name);
  }
  return body;
}

/** Runs the claim guard on every step (see header). */
export function checkSequenceClaims(
  ctx: ClaimContext,
  steps: SequenceStepDraft[],
  sequence: EmailSequence,
  now: Date = new Date(),
): SequenceCheckResult {
  const offsets = cumulativeOffsetDays(sequence);
  const failures: StepViolations[] = [];
  for (const step of steps) {
    const result = runClaimCheck(
      ctx,
      { subject: step.step_no === 1 ? (step.subject ?? "") : "", body: step.body, claims: step.claims },
      now,
      { mode: step.source, offsetDays: offsets.get(step.step_no) ?? 0, stepNo: step.step_no },
    );
    if (!result.ok) failures.push({ step: step.step_no, violations: result.violations });
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/** One line per violation, prefixed with its step. */
export function formatStepViolations(failures: StepViolations[], max = 12): string[] {
  return failures.flatMap((f) => formatViolations(f.violations, max).map((line) => `step ${f.step}: ${line}`));
}

/**
 * `step2_repeats_step1` (09 §U6c S20, operator addition from the live v10
 * draft): every writer follow-up must cite at least one evidence id that step
 * 1 does not, so it is a new angle rather than step 1's observation again.
 * Deterministic, on the claim ledgers; template steps are exempt. Checked at
 * draft (one revision retry, then hold) and again at approval.
 */
export type RepeatIssue = { step: number; step1_ids: string[]; step_ids: string[] };

export const STEP_REPEATS_REASON = "step2_repeats_step1";

export function stepsRepeatingStepOne(steps: Pick<SequenceStepDraft, "step_no" | "source" | "claims">[]): RepeatIssue[] {
  const citedBy = (step: Pick<SequenceStepDraft, "claims">) =>
    [...new Set(step.claims.flatMap((c) => c.evidence_ids))].sort();
  const first = steps.find((s) => s.step_no === 1);
  const firstIds = first ? citedBy(first) : [];
  const issues: RepeatIssue[] = [];
  for (const step of steps) {
    if (step.step_no < 2 || step.source !== "writer") continue;
    const ids = citedBy(step);
    if (!ids.some((id) => !firstIds.includes(id))) issues.push({ step: step.step_no, step1_ids: firstIds, step_ids: ids });
  }
  return issues;
}

/** One line per issue, e.g. "step 2: step2_repeats_step1 — cites only E1 (step 1 cites E1, E2)". */
export function formatRepeatIssues(issues: RepeatIssue[]): string[] {
  return issues.map(
    (i) =>
      `step ${i.step}: ${STEP_REPEATS_REASON} — cites ${i.step_ids.length ? `only ${i.step_ids.join(", ")}` : "no evidence"} (step 1 cites ${i.step1_ids.join(", ") || "none"})`,
  );
}
