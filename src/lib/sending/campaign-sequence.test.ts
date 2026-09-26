import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  diffCampaignSequence,
  instantlySequencePayload,
  planCampaignUpdate,
  toInstantlySteps,
  type EngineStepTiming,
  type LiveCampaignStep,
} from "@/lib/sending/campaign-sequence";

// 09 §U6c S20 — DoD rows M1 (delay mapping) and C1 (campaign --update refusals).

const days = (...delays: number[]): EngineStepTiming[] =>
  delays.map((delay, i) => ({ step_no: i + 1, delay, delay_unit: "days" }));

const delaysOf = (steps: { delay: number }[]) => steps.map((s) => s.delay);

/** A live campaign exactly as the mapping would build it, with the given Instantly delays. */
function live(delays: number[], unit = "days"): LiveCampaignStep[] {
  return delays.map((delay, i) => ({
    type: "email",
    delay,
    delay_unit: unit,
    variants: [i === 0 ? { subject: "{{zx_subject}}", body: "{{zx_body}}" } : { subject: "", body: `{{zx_body_${i + 1}}}` }],
  }));
}

describe("M1: engine 'after previous' delays → Instantly 'before next' delays", () => {
  test("v1 0/7/7 → 7, 7, 7 (last repeats the last engine delay)", () => {
    assert.deepEqual(delaysOf(toInstantlySteps(days(0, 7, 7))), [7, 7, 7]);
  });

  test("distinct 0/7/14 → 7, 14, 14 — a wrong-way shift cannot pass", () => {
    const mapped = toInstantlySteps(days(0, 7, 14));
    assert.deepEqual(delaysOf(mapped), [7, 14, 14]);
    assert.notDeepEqual(delaysOf(mapped), [0, 7, 14], "unshifted");
    assert.notDeepEqual(delaysOf(mapped), [14, 14, 14], "doubly shifted");
  });

  test("the drift diff refuses an unshifted and a doubly shifted live campaign", () => {
    const seq = days(0, 7, 14);
    assert.deepEqual(diffCampaignSequence(live([7, 14, 14]), seq), []);
    const unshifted = diffCampaignSequence(live([0, 7, 14]), seq);
    // Steps 1 and 2 differ; step 3 (14) happens to equal the repeated last delay.
    assert.deepEqual(unshifted, ["step 1: delay 0 days (want 7 days)", "step 2: delay 7 days (want 14 days)"]);
    const doubly = diffCampaignSequence(live([14, 14, 14]), seq);
    assert.ok(doubly.some((p) => p.startsWith("step 1: delay 14 days (want 7 days)")), doubly.join("; "));
  });

  test("units map with their delay (drill minutes 0/5/20 → 5, 20, 20 minutes)", () => {
    const drill: EngineStepTiming[] = [
      { step_no: 1, delay: 0, delay_unit: "minutes" },
      { step_no: 2, delay: 5, delay_unit: "minutes" },
      { step_no: 3, delay: 20, delay_unit: "minutes" },
    ];
    assert.deepEqual(toInstantlySteps(drill), [
      { delay: 5, delay_unit: "minutes" },
      { delay: 20, delay_unit: "minutes" },
      { delay: 20, delay_unit: "minutes" },
    ]);
    assert.deepEqual(diffCampaignSequence(live([5, 20, 20], "minutes"), drill), []);
    assert.equal(diffCampaignSequence(live([5, 20, 20]), drill).length, 3, "days ≠ minutes");
  });

  test("payload: step 1 {{zx_subject}}/{{zx_body}}, follow-ups empty subject + {{zx_body_N}}", () => {
    const [seq] = instantlySequencePayload(days(0, 7, 7));
    assert.deepEqual(seq!.steps, [
      { type: "email", delay: 7, delay_unit: "days", variants: [{ subject: "{{zx_subject}}", body: "{{zx_body}}" }] },
      { type: "email", delay: 7, delay_unit: "days", variants: [{ subject: "", body: "{{zx_body_2}}" }] },
      { type: "email", delay: 7, delay_unit: "days", variants: [{ subject: "", body: "{{zx_body_3}}" }] },
    ]);
  });

  test("drift: the current single-step campaign, a missing delay_unit (= days), a changed template, an extra variant", () => {
    const seq = days(0, 7, 7);
    const single = diffCampaignSequence([{ type: "email", delay: 0, variants: [{ subject: "{{zx_subject}}", body: "{{zx_body}}" }] }], seq);
    assert.ok(single.includes("campaign has 1 step(s), the sequence has 3"), single.join("; "));
    const noUnit = live([7, 7, 7]).map((st) => ({ ...st, delay_unit: undefined }));
    assert.deepEqual(diffCampaignSequence(noUnit, seq), [], "missing delay_unit reads as days");
    const changed = live([7, 7, 7]);
    changed[1]!.variants = [{ subject: "Re: hi", body: "{{zx_body_2}}" }];
    assert.equal(diffCampaignSequence(changed, seq).length, 1);
    const extra = live([7, 7, 7]);
    extra[2]!.variants!.push({ subject: "", body: "other" });
    assert.equal(diffCampaignSequence(extra, seq).length, 1);
    const disabled = live([7, 7, 7]);
    disabled[2]!.variants!.push({ subject: "", body: "other", v_disabled: true });
    assert.deepEqual(diffCampaignSequence(disabled, seq), [], "a disabled variant never sends");
  });
});

describe("C1: --update refuses unless the campaign is paused and holds 0 leads", () => {
  const seq = days(0, 7, 7);
  const oneStep = [{ steps: live([0]) }];

  test("active → campaign_not_paused", () => {
    const plan = planCampaignUpdate({ status: 1, sequences: oneStep }, 0, seq);
    assert.equal(plan.ok, false);
    assert.equal(!plan.ok && plan.reason, "campaign_not_paused");
  });

  test("completed → campaign_not_paused", () => {
    const plan = planCampaignUpdate({ status: 3, sequences: oneStep }, 0, seq);
    assert.equal(!plan.ok && plan.reason, "campaign_not_paused");
  });

  test("paused with leads → campaign_has_leads", () => {
    const plan = planCampaignUpdate({ status: 2, sequences: oneStep }, 2, seq);
    assert.equal(!plan.ok && plan.reason, "campaign_has_leads");
  });

  test("paused (or draft) with 0 leads → the mapped payload, and what it changes", () => {
    for (const status of [2, 0]) {
      const plan = planCampaignUpdate({ status, sequences: oneStep }, 0, seq);
      assert.ok(plan.ok);
      if (!plan.ok) return;
      assert.deepEqual(delaysOf(plan.payload.sequences[0]!.steps), [7, 7, 7]);
      assert.ok(plan.problems.includes("campaign has 1 step(s), the sequence has 3"));
    }
  });
});
