import type { EmailSequence } from "@/lib/sending/sequence-approval";

// The Instantly side of an engine email sequence (09 §U6c S20). Pure.
//
// The two systems mean different things by a step's `delay`:
//   engine   email_sequence step N `delay` = the wait AFTER THE PREVIOUS step
//            (step 1 = 0; v1 0/7/7 → days 0/7/14);
//   Instantly step N `delay` = "The delay value before sending the NEXT email"
//            (OpenAPI spec, PATCH /api/v2/campaigns/{id}).
// So engine step N+1's delay goes on Instantly step N. The last Instantly step
// has no next email; it repeats the last engine step's delay and unit: the
// help discourages 0, the value never gates a send, and one unit keeps the
// drift diff uniform (06 §5, Session 20). S22 confirms the mapping live with
// distinct per-step delays.
//
// Step 1 carries the lead's own subject/body variables; every follow-up has
// an empty subject (S18: accepted, sent as "Re: <step 1 subject>" in the same
// thread) and its own body variable {{zx_body_N}}, set once at enroll.

export type DelayUnit = "minutes" | "hours" | "days";

/** The part of an engine step the mapping needs (production or drill). */
export type EngineStepTiming = { step_no: number; delay: number; delay_unit: DelayUnit };

export type InstantlyStepTiming = { delay: number; delay_unit: DelayUnit };

export type InstantlySequenceStep = {
  type: "email";
  delay: number;
  delay_unit: DelayUnit;
  variants: Array<{ subject: string; body: string }>;
};

/** Engine delays ("after previous") → Instantly delays ("before next"), one per step. */
export function toInstantlySteps(steps: EngineStepTiming[]): InstantlyStepTiming[] {
  const ordered = [...steps].sort((a, b) => a.step_no - b.step_no);
  if (ordered.length === 0) return [];
  const last = ordered[ordered.length - 1]!;
  return ordered.map((_, i) => {
    const next = ordered[i + 1] ?? last;
    return { delay: next.delay, delay_unit: next.delay_unit };
  });
}

/** Lead variable holding step N's composed body (step 1 keeps the U5 name). */
export function bodyVariable(stepNo: number): string {
  return stepNo === 1 ? "zx_body" : `zx_body_${stepNo}`;
}

export const SUBJECT_VARIABLE = "zx_subject";

/** The template each Instantly step must carry. */
export function stepTemplate(stepNo: number): { subject: string; body: string } {
  return stepNo === 1
    ? { subject: `{{${SUBJECT_VARIABLE}}}`, body: `{{${bodyVariable(1)}}}` }
    : { subject: "", body: `{{${bodyVariable(stepNo)}}}` };
}

/** The `sequences` value for POST/PATCH /api/v2/campaigns. */
export function instantlySequencePayload(steps: EngineStepTiming[]): Array<{ steps: InstantlySequenceStep[] }> {
  const ordered = [...steps].sort((a, b) => a.step_no - b.step_no);
  const timings = toInstantlySteps(ordered);
  return [
    {
      steps: ordered.map((step, i) => ({
        type: "email" as const,
        delay: timings[i]!.delay,
        delay_unit: timings[i]!.delay_unit,
        variants: [stepTemplate(step.step_no)],
      })),
    },
  ];
}

export function engineTimings(sequence: EmailSequence): EngineStepTiming[] {
  return sequence.steps.map((s) => ({ step_no: s.step_no, delay: s.delay, delay_unit: s.delay_unit }));
}

/** A live campaign step as GET /api/v2/campaigns/{id} returns it. */
export type LiveCampaignStep = {
  type?: string;
  delay?: number | null;
  delay_unit?: string | null;
  variants?: Array<{ subject?: string | null; body?: string | null; v_disabled?: boolean | null }> | null;
};

/**
 * Differences between a live campaign's steps and the sequence, through the
 * mapping. Empty = the campaign sends exactly the approved shape. A missing
 * `delay_unit` reads as days (the spec default).
 */
export function diffCampaignSequence(live: LiveCampaignStep[] | null | undefined, steps: EngineStepTiming[]): string[] {
  const want = instantlySequencePayload(steps)[0]!.steps;
  const got = live ?? [];
  const problems: string[] = [];
  if (got.length !== want.length) {
    problems.push(`campaign has ${got.length} step(s), the sequence has ${want.length}`);
  }
  want.forEach((w, i) => {
    const g = got[i];
    if (!g) return;
    const n = i + 1;
    const unit = g.delay_unit ?? "days";
    if (g.delay !== w.delay || unit !== w.delay_unit) {
      problems.push(`step ${n}: delay ${String(g.delay)} ${unit} (want ${w.delay} ${w.delay_unit})`);
    }
    const variants = (g.variants ?? []).filter((v) => v.v_disabled !== true);
    const tpl = w.variants[0]!;
    if (variants.length !== 1 || (variants[0]!.subject ?? "") !== tpl.subject || (variants[0]!.body ?? "") !== tpl.body) {
      problems.push(
        `step ${n}: variants ${JSON.stringify(variants.map((v) => ({ subject: v.subject ?? "", body: v.body ?? "" })))} ` +
          `(want exactly ${JSON.stringify(tpl)})`,
      );
    }
    if (g.type !== undefined && g.type !== "email") problems.push(`step ${n}: type ${g.type} (want email)`);
  });
  return problems;
}

/** Instantly campaign statuses that cannot send (spec: 0 draft, 2 paused). */
const NOT_SENDING_STATUSES = [0, 2];

export type CampaignUpdatePlan =
  | { ok: true; payload: { sequences: Array<{ steps: InstantlySequenceStep[] }> }; problems: string[] }
  | { ok: false; reason: "campaign_not_paused" | "campaign_has_leads"; detail: Record<string, unknown> };

/**
 * `instantly-sender-campaigns.ts --update` (09 §U6c scope 8). Adding steps to a
 * campaign "reactivates previously completed leads" (Instantly help), and a
 * running campaign would start sending the new shape at once. So the update is
 * planned only for a campaign that is not sending AND holds no lead at all.
 */
export function planCampaignUpdate(
  live: { status: number; sequences?: Array<{ steps: LiveCampaignStep[] }> | null },
  leadCount: number,
  steps: EngineStepTiming[],
): CampaignUpdatePlan {
  if (!NOT_SENDING_STATUSES.includes(live.status)) {
    return { ok: false, reason: "campaign_not_paused", detail: { status: live.status } };
  }
  if (leadCount !== 0) return { ok: false, reason: "campaign_has_leads", detail: { leads: leadCount } };
  return {
    ok: true,
    payload: { sequences: instantlySequencePayload(steps) },
    problems: diffCampaignSequence(live.sequences?.[0]?.steps, steps),
  };
}
