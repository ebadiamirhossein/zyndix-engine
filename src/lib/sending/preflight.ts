import type { z } from "zod";

import { nextSendWindow, type SendWindow } from "@/lib/scheduler/windows";
import { approvalHash, buildApprovalSnapshot, normalizeSignature, threadedSubject } from "@/lib/sending/approval";
import { diffCampaignSequence, engineTimings, type LiveCampaignStep } from "@/lib/sending/campaign-sequence";
import { checkSenderDomain } from "@/lib/sending/guard";
import {
  isSequenceSnapshot,
  recomputeSequenceHash,
  type EmailSequence,
  type SequenceTouch,
} from "@/lib/sending/sequence-approval";
import { resolveRecipientTimezone, type ResolvedTimezone } from "@/lib/sending/timezone";
import type { sendPolicySchema, sendWindowsSchema } from "@/lib/validation/jsonb";
import { PREFLIGHT_REFUSALS, type LeadState, type PreflightRefusal } from "@/types/enums";

// Preflight (09 §U5, brief §10). Pure: the send stage loads a fresh context
// immediately before every dispatch and this returns EVERY failing rule, in
// the fixed order of PREFLIGHT_REFUSALS, so the operator sees exactly which
// rules stopped a send. An empty list is the only "ok".

export type SendPolicy = z.infer<typeof sendPolicySchema>;
export type SendWindowsConfig = z.infer<typeof sendWindowsSchema>;

export type PreflightVerdict = { reason: PreflightRefusal; detail?: Record<string, unknown> };

export type PreflightContext = {
  now: Date;
  touch: {
    id: string;
    step_no: number | null;
    channel: string | null;
    direction: string | null;
    status: string | null;
    subject: string | null;
    body: string | null;
    prompt_version: number | null;
    approval_hash: string | null;
    /** 0009c (09 §U6b): in the approval snapshot, so a changed ledger is stale. */
    claim_ledger?: unknown;
    /** The stored snapshot: its `kind` says whether the touch was approved as a sequence (09 §U6c). */
    approval_snapshot?: unknown;
  };
  /**
   * 09 §U6c: for a touch approved as part of a sequence, every step's touch
   * (same approval hash) and the ACTIVE email_sequence setting. The hash is
   * rebuilt from these, so a changed step, delay, sender or signature is
   * stale. Null/absent for a sequence-approved touch → stale (fail closed).
   */
  sequence?: { touches: SequenceTouch[]; setting: { version: number; value: EmailSequence } } | null;
  /**
   * 09 §U6c S20, step 1 only: the steps of the sender's live Instantly
   * campaign (GET /api/v2/campaigns/{id}). Null = unreadable → drift (hold).
   */
  campaignSteps?: LiveCampaignStep[] | null;
  /**
   * 09 §U6c S20, step 1 only: Instantly's own daily budget for the sender.
   * Follow-ups count against daily_limit, so the enroll needs room for itself
   * plus every follow-up Instantly will send today. Null/unknown values fail
   * closed (sender_unhealthy provider_daily_unread).
   */
  providerDaily?: { dailyLimit: number | null; sentToday: number | null; followupsDueToday: number } | null;
  lead: {
    id: string;
    state: LeadState;
    email: string | null;
    email_status: string | null;
    email_verified_at: string | null;
    timezone: string | null;
    do_not_contact: boolean | null;
    /** The binding (0008). Null until the first send binds it. */
    send_account_id: string | null;
  };
  company: { domain: string | null; timezone: string | null; country: string | null } | null;
  /** The account this dispatch would go out from. */
  sender: {
    id: string;
    identifier: string;
    health: string | null;
    instantly_campaign_id: string | null;
    /** Plain-text signature (0009). Covered by the approval hash. */
    signature_text: string | null;
  };
  /** Instantly accountHealth verdict for the sender, and its warmup score. Null = not read. */
  providerHealth: { verdict: "healthy" | "degraded" | "unhealthy" | "unknown"; warmupScore: number | null } | null;
  suppression: { email: boolean; domain: boolean };
  /** An inbound touch or a replied_at exists for this lead. */
  hasReply: boolean;
  /** Other leads at the same company in active outreach (see send stage). */
  companyConflicts: number;
  /** Remaining capacity on the sender's ledger day; null = quota unknown (ramp not started is set at reserve). */
  capacityRemaining: number | null;
  /**
   * 09 §U9: operations_pause as the send stage read it — the global switch and
   * whether the sender's Instantly campaign is in paused_campaign_ids. Absent
   * = not paused (contexts built before U9).
   */
  pause?: { global: boolean; reason: string | null; campaignPaused: boolean } | null;
  policy: SendPolicy;
  windows: SendWindowsConfig;
};

export type PreflightResult = {
  verdicts: PreflightVerdict[];
  ok: boolean;
  timezone: ResolvedTimezone | null;
  window: SendWindow | null;
  recomputedHash: string;
};

const REPLY_STATES: readonly LeadState[] = ["replied", "classifying", "human_review"];
const BOOKING_STATES: readonly LeadState[] = ["meeting_booked", "handed_off"];
const DAY_MS = 86_400_000;

export { threadedSubject };

export function preflight(ctx: PreflightContext): PreflightResult {
  const verdicts: PreflightVerdict[] = [];
  const add = (reason: PreflightRefusal, detail?: Record<string, unknown>) => verdicts.push({ reason, detail });
  const step = ctx.touch.step_no ?? 1;

  // 09 §U6c S20: steps >= 2 are Instantly campaign steps. The engine's
  // emails/reply path kept our own mailbox in To (Sessions 14, 16), so it is
  // hard-disabled; runSendJob refuses before this, this is defence in depth.
  if (step > 1) add("followup_engine_send_disabled", { step });

  // 09 §U9: the operator's pause switches. Deferrable: lifting the pause is
  // an operator action, and the send goes in a window after that.
  if (ctx.pause?.global) add("operations_paused", { reason: ctx.pause.reason });
  if (ctx.pause?.campaignPaused) add("campaign_paused", { campaign_id: ctx.sender.instantly_campaign_id });

  // Sender: domain guard, then pinning.
  const domain = checkSenderDomain(ctx.sender.identifier);
  if (!domain.ok) add(domain.reason, { sender: ctx.sender.identifier, domain: domain.domain });
  if (ctx.lead.send_account_id !== null && ctx.lead.send_account_id !== ctx.sender.id) {
    add("sender_mismatch", { bound: ctx.lead.send_account_id, attempted: ctx.sender.id });
  } else if (ctx.lead.send_account_id === null && step > 1) {
    // A follow-up with no binding means step 1 never bound a sender.
    add("sender_mismatch", { bound: null, attempted: ctx.sender.id, step });
  }

  // Lead state. Stop states have their own reasons; anything else unexpected
  // is lead_state_invalid.
  const state = ctx.lead.state;
  if (REPLY_STATES.includes(state)) add("reply_freeze", { state });
  else if (BOOKING_STATES.includes(state)) add("booking_hold", { state });
  else if (state === "manual_hold") add("manual_hold", { state });
  else if (state !== "suppressed") {
    const expected: LeadState[] = step === 1 ? ["approved", "queued"] : ["sent"];
    if (!expected.includes(state)) add("lead_state_invalid", { state, expected, step });
  }

  if (ctx.touch.channel !== "email" || ctx.touch.direction !== "outbound") {
    add("channel_unsupported", { channel: ctx.touch.channel, direction: ctx.touch.direction });
  }

  // Approval bound to content + recipient.
  // The sender and its signature are in the snapshot (Session 12): a touch
  // approved for another mailbox, or a signature edited since, is stale.
  // Session 19 (09 §U6c): a sequence-approved touch carries ONE hash over
  // every step; it is rebuilt from all the steps, never from this touch alone.
  const recomputedHash = isSequenceSnapshot(ctx.touch.approval_snapshot)
    ? ((ctx.sequence
        ? recomputeSequenceHash({ lead: ctx.lead, sender: ctx.sender, sequence: ctx.sequence.setting, touches: ctx.sequence.touches })
        : null) ?? "sequence_not_rebuildable")
    : approvalHash(buildApprovalSnapshot({ ...ctx.touch, id: ctx.touch.id }, ctx.lead, ctx.sender));
  if (ctx.touch.status !== "approved" || !ctx.touch.approval_hash || ctx.touch.approval_hash !== recomputedHash) {
    add("stale_approval", {
      touch_status: ctx.touch.status,
      has_approval: Boolean(ctx.touch.approval_hash),
      hash_matches: ctx.touch.approval_hash === recomputedHash,
    });
  }

  // 09 §U6c S20: the enroll starts the whole approved sequence, so every step
  // must be there, approved and non-blank (the blank-email guard: Instantly
  // sends an empty variable as an empty email), and the live campaign must
  // send exactly that shape through the delay mapping.
  if (step === 1) {
    if (!isSequenceSnapshot(ctx.touch.approval_snapshot)) {
      add("sequence_incomplete", { reason: "not_sequence_approved" });
    } else if (ctx.sequence) {
      const issues = sequenceIncompleteness(ctx.touch.id, ctx.sequence);
      if (issues.length > 0) add("sequence_incomplete", { issues });
      if (ctx.campaignSteps === null || ctx.campaignSteps === undefined) {
        add("campaign_sequence_drift", { reason: "campaign_unreadable", campaign_id: ctx.sender.instantly_campaign_id });
      } else {
        const problems = diffCampaignSequence(ctx.campaignSteps, engineTimings(ctx.sequence.setting.value));
        if (problems.length > 0) {
          add("campaign_sequence_drift", {
            campaign_id: ctx.sender.instantly_campaign_id,
            sequence_setting_version: ctx.sequence.setting.version,
            problems,
          });
        }
      }
    }
  }

  // Suppression, person-level then company-wide.
  if (ctx.suppression.email || ctx.lead.do_not_contact || state === "suppressed") {
    add("suppressed_email", {
      suppression_row: ctx.suppression.email,
      do_not_contact: Boolean(ctx.lead.do_not_contact),
      state_suppressed: state === "suppressed",
    });
  }
  if (ctx.suppression.domain) add("suppressed_domain");

  // A reply freezes outreach even if the lead state has not caught up yet.
  if (ctx.hasReply && !REPLY_STATES.includes(state)) add("reply_freeze", { source: "touches" });

  // Verification.
  const status = ctx.lead.email_status;
  if (!ctx.lead.email || status === "invalid") {
    add("email_invalid", { email_status: status, has_email: Boolean(ctx.lead.email) });
  } else {
    const verifiedAt = ctx.lead.email_verified_at ? Date.parse(ctx.lead.email_verified_at) : NaN;
    const ageDays = Number.isFinite(verifiedAt) ? (ctx.now.getTime() - verifiedAt) / DAY_MS : null;
    const statusOk = status === "valid" || (status === "catch_all" && ctx.policy.allow_catch_all);
    if (!statusOk || ageDays === null || ageDays > ctx.policy.verification_max_age_days) {
      add("email_unverified", {
        email_status: status,
        verified_age_days: ageDays === null ? null : Math.floor(ageDays),
        max_age_days: ctx.policy.verification_max_age_days,
        allow_catch_all: ctx.policy.allow_catch_all,
      });
    }
  }

  // Sender health fails closed: unknown is not healthy.
  const reasons: string[] = [];
  if (ctx.sender.health !== "ok") reasons.push(`send_accounts.health=${ctx.sender.health}`);
  if (!ctx.providerHealth) reasons.push("provider_health_unread");
  else {
    if (ctx.providerHealth.verdict !== "healthy") reasons.push(`instantly=${ctx.providerHealth.verdict}`);
    if (ctx.providerHealth.warmupScore === null) reasons.push("warmup_score_unknown");
    else if (ctx.providerHealth.warmupScore < ctx.policy.min_warmup_score) {
      reasons.push(`warmup_score=${ctx.providerHealth.warmupScore}<${ctx.policy.min_warmup_score}`);
    }
  }
  if (step === 1 && !ctx.sender.instantly_campaign_id) reasons.push("no_instantly_campaign");
  const daily = ctx.providerDaily;
  if (step === 1 && (!daily || daily.dailyLimit === null || daily.sentToday === null)) {
    reasons.push("provider_daily_unread");
  }
  if (reasons.length > 0) add("sender_unhealthy", { reasons });
  if (!normalizeSignature(ctx.sender.signature_text)) add("sender_signature_missing", { sender: ctx.sender.identifier });

  if (ctx.companyConflicts > 0) add("duplicate_company_active", { other_leads: ctx.companyConflicts });

  // Timezone: unknown is a HOLD (timezone_unknown), never outside_window.
  const timezone = resolveRecipientTimezone({
    leadTimezone: ctx.lead.timezone,
    companyTimezone: ctx.company?.timezone,
    companyCountry: ctx.company?.country,
  });
  let window: SendWindow | null = null;
  if (!timezone) {
    add("timezone_unknown", { lead_timezone: ctx.lead.timezone, company_timezone: ctx.company?.timezone ?? null, country: ctx.company?.country ?? null });
  } else {
    window = nextSendWindow(ctx.now, timezone.timeZone, ctx.windows);
    const inside = window.opensAt.getTime() <= ctx.now.getTime() && ctx.now.getTime() < window.end.getTime();
    if (!inside) {
      add("outside_window", { time_zone: timezone.timeZone, source: timezone.source, next_opens_at: window.start.toISOString() });
    }
  }

  if (ctx.capacityRemaining !== null && ctx.capacityRemaining <= 0) {
    add("quota_exhausted", { remaining: ctx.capacityRemaining });
  }

  // 09 §U6c S20: this enroll + today's follow-ups must fit Instantly's
  // daily_limit, or the enroll would wait in the campaign past the window.
  if (step === 1 && daily && daily.dailyLimit !== null && daily.sentToday !== null) {
    if (daily.sentToday + daily.followupsDueToday + 1 > daily.dailyLimit) {
      add("provider_daily_limit", {
        daily_limit: daily.dailyLimit,
        sent_today: daily.sentToday,
        followups_due_today: daily.followupsDueToday,
      });
    }
  }

  // De-duplicate a reason reported twice (e.g. reply_freeze from state and touches).
  // Then report in the fixed PREFLIGHT_REFUSALS order.
  const seen = new Set<PreflightRefusal>();
  const ordered = verdicts
    .filter((v) => (seen.has(v.reason) ? false : (seen.add(v.reason), true)))
    .sort((a, b) => PREFLIGHT_REFUSALS.indexOf(a.reason) - PREFLIGHT_REFUSALS.indexOf(b.reason));
  return { verdicts: ordered, ok: ordered.length === 0, timezone, window, recomputedHash };
}

/** Refusals the send stage defers to the next window rather than holding. */
export const DEFERRABLE_REFUSALS: readonly PreflightRefusal[] = [
  "operations_paused",
  "campaign_paused",
  "outside_window",
  "quota_exhausted",
  "provider_daily_limit",
];

export type SequenceIssue = { step: number; issue: "missing" | "killed" | "not_approved" | "blank"; status?: string | null };

/**
 * What is wrong with an approved sequence at enroll (09 §U6c S20). Every step
 * of the active email_sequence needs its touch under the approval hash; the
 * follow-ups must still be `approved` (killed → the sequence is incomplete);
 * no step body may be empty or whitespace. Step 1's own status is judged by
 * stale_approval.
 */
export function sequenceIncompleteness(
  stepOneTouchId: string,
  sequence: NonNullable<PreflightContext["sequence"]>,
): SequenceIssue[] {
  const issues: SequenceIssue[] = [];
  for (const spec of sequence.setting.value.steps) {
    const touch = sequence.touches.find((t) => t.step_no === spec.step_no);
    if (!touch) {
      issues.push({ step: spec.step_no, issue: "missing" });
      continue;
    }
    if (touch.id !== stepOneTouchId && touch.status !== "approved") {
      issues.push({ step: spec.step_no, issue: touch.status === "killed" ? "killed" : "not_approved", status: touch.status ?? null });
    }
    if (!(touch.body ?? "").trim()) issues.push({ step: spec.step_no, issue: "blank" });
  }
  return issues;
}
