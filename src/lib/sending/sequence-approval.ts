import { createHash } from "node:crypto";

import type { z } from "zod";

import { canonicalJson, composeOutboundBody, normalizeSignature, threadedSubject } from "@/lib/sending/approval";
import type { emailSequenceSchema } from "@/lib/validation/jsonb";

// Sequence approval binding (09 §U6c). One Telegram approval covers every step
// of an email sequence: step 1 is enrolled by the engine, steps >= 2 are sent
// by Instantly as campaign steps with no further engine check on their text.
// So the approval must bind every step up front, exactly as the recipient
// will read it:
//   - subject: step 1's own; a follow-up's as Instantly renders it,
//     "Re: <step-1 subject>" (S18: an empty step subject continues the thread);
//   - body: the composed body (approved body + mailbox signature), per step;
//   - delay: when each follow-up leaves, from the email_sequence version;
//   - claim ledger: what each step claims;
//   - recipient, sender, signature, campaign, sequence setting version.
// Every follow-up also carries a quote of step 1 (S18). Step 1's composed body
// is in this same hash, so the quote only repeats approved text.
//
// One hash over the whole snapshot is written on every step's touch. Preflight
// rebuilds it from the stored touches and the ACTIVE email_sequence setting,
// so a changed delay, signature, sender or step text is `stale_approval`.

export type EmailSequence = z.infer<typeof emailSequenceSchema>;

export const SEQUENCE_SNAPSHOT_KIND = "email_sequence";

export type SequenceSnapshotStep = {
  touch_id: string;
  step_no: number;
  subject: string;
  body: string;
  delay: number;
  delay_unit: string;
  claim_ledger: unknown[] | null;
};

export type SequenceApprovalSnapshot = {
  kind: typeof SEQUENCE_SNAPSHOT_KIND;
  lead_id: string;
  recipient: string;
  channel: string;
  send_account_id: string;
  campaign_id: string | null;
  signature: string | null;
  sequence_setting_version: number;
  prompt_version: number | null;
  steps: SequenceSnapshotStep[];
};

/** A step's touch as stored (or about to be stored) — body is the approved, uncomposed body. */
export type SequenceTouch = {
  id: string;
  step_no: number | null;
  channel?: string | null;
  subject: string | null;
  body: string | null;
  prompt_version: number | null;
  claim_ledger?: unknown;
};

export class SequenceShapeError extends Error {}

/**
 * Builds the snapshot. Throws SequenceShapeError unless the touches are
 * exactly the steps of `sequence`, one each, and step 1 has a subject.
 */
export function buildSequenceApprovalSnapshot(input: {
  lead: { id: string; email: string | null };
  sender: { id: string; signature_text: string | null; instantly_campaign_id: string | null };
  sequence: { version: number; value: EmailSequence };
  touches: SequenceTouch[];
}): SequenceApprovalSnapshot {
  const touches = [...input.touches].sort((a, b) => (a.step_no ?? 0) - (b.step_no ?? 0));
  const expected = input.sequence.value.steps.map((s) => s.step_no);
  const got = touches.map((t) => t.step_no ?? 0);
  if (got.length !== expected.length || got.some((n, i) => n !== expected[i])) {
    throw new SequenceShapeError(`touches are steps [${got.join(",")}], sequence v${input.sequence.version} has [${expected.join(",")}]`);
  }
  const first = touches[0]!;
  const firstSubject = (first.subject ?? "").trim();
  if (!firstSubject) throw new SequenceShapeError("step 1 has no subject");

  const signature = normalizeSignature(input.sender.signature_text);
  const steps = touches.map((touch, i) => {
    const spec = input.sequence.value.steps[i]!;
    return {
      touch_id: touch.id,
      step_no: spec.step_no,
      subject: spec.step_no === 1 ? firstSubject : threadedSubject(firstSubject),
      body: composeOutboundBody(touch.body ?? "", signature),
      delay: spec.delay,
      delay_unit: spec.delay_unit,
      claim_ledger: Array.isArray(touch.claim_ledger) ? touch.claim_ledger : null,
    };
  });

  return {
    kind: SEQUENCE_SNAPSHOT_KIND,
    lead_id: input.lead.id,
    recipient: (input.lead.email ?? "").trim().toLowerCase(),
    channel: first.channel ?? "email",
    send_account_id: input.sender.id,
    campaign_id: input.sender.instantly_campaign_id,
    signature,
    sequence_setting_version: input.sequence.version,
    prompt_version: first.prompt_version ?? null,
    steps,
  };
}

export function sequenceApprovalHash(snapshot: SequenceApprovalSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/** True when a stored approval_snapshot is a sequence snapshot (not a single-touch one). */
export function isSequenceSnapshot(snapshot: unknown): boolean {
  return (
    typeof snapshot === "object" &&
    snapshot !== null &&
    !Array.isArray(snapshot) &&
    (snapshot as { kind?: unknown }).kind === SEQUENCE_SNAPSHOT_KIND
  );
}

/**
 * Preflight's recompute for a sequence-approved touch: the hash the stored
 * state would produce now, or null when it cannot be rebuilt at all (a step
 * missing or extra, no subject) — which preflight treats as stale.
 */
export function recomputeSequenceHash(input: Parameters<typeof buildSequenceApprovalSnapshot>[0]): string | null {
  try {
    return sequenceApprovalHash(buildSequenceApprovalSnapshot(input));
  } catch (error) {
    if (error instanceof SequenceShapeError) return null;
    throw error;
  }
}

/** Days after step 1 that each step goes out: the running sum of delays (days only in production). */
export function cumulativeOffsetDays(sequence: EmailSequence): Map<number, number> {
  const out = new Map<number, number>();
  let total = 0;
  for (const step of sequence.steps) {
    total += step.delay_unit === "days" ? step.delay : step.delay_unit === "hours" ? step.delay / 24 : step.delay / 1440;
    out.set(step.step_no, total);
  }
  return out;
}
