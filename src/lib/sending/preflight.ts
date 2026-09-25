import type { z } from "zod";

import { nextSendWindow, type SendWindow } from "@/lib/scheduler/windows";
import { approvalHash, buildApprovalSnapshot } from "@/lib/sending/approval";
import { checkSenderDomain } from "@/lib/sending/guard";
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
  };
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
  sender: { id: string; identifier: string; health: string | null; instantly_campaign_id: string | null };
  /** Instantly accountHealth verdict for the sender, and its warmup score. Null = not read. */
  providerHealth: { verdict: "healthy" | "degraded" | "unhealthy" | "unknown"; warmupScore: number | null } | null;
  suppression: { email: boolean; domain: boolean };
  /** An inbound touch or a replied_at exists for this lead. */
  hasReply: boolean;
  /** Other leads at the same company in active outreach (see send stage). */
  companyConflicts: number;
  /** Remaining capacity on the sender's ledger day; null = quota unknown (ramp not started is set at reserve). */
  capacityRemaining: number | null;
  /** For step >= 2: the step-1 email this follow-up replies to. */
  threadAnchor: { emailId: string; subject: string } | null;
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

/** "Re: <subject>", without stacking prefixes. */
export function threadedSubject(subject: string): string {
  const s = subject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export function preflight(ctx: PreflightContext): PreflightResult {
  const verdicts: PreflightVerdict[] = [];
  const add = (reason: PreflightRefusal, detail?: Record<string, unknown>) => verdicts.push({ reason, detail });
  const step = ctx.touch.step_no ?? 1;

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
  const recomputedHash = approvalHash(buildApprovalSnapshot({ ...ctx.touch, id: ctx.touch.id }, ctx.lead));
  if (ctx.touch.status !== "approved" || !ctx.touch.approval_hash || ctx.touch.approval_hash !== recomputedHash) {
    add("stale_approval", {
      touch_status: ctx.touch.status,
      has_approval: Boolean(ctx.touch.approval_hash),
      hash_matches: ctx.touch.approval_hash === recomputedHash,
    });
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
  if (reasons.length > 0) add("sender_unhealthy", { reasons });

  if (ctx.companyConflicts > 0) add("duplicate_company_active", { other_leads: ctx.companyConflicts });

  if (step > 1) {
    if (!ctx.threadAnchor) add("thread_anchor_missing", { step });
    else if ((ctx.touch.subject ?? "").trim() !== threadedSubject(ctx.threadAnchor.subject)) {
      add("stale_approval", { thread_subject: "follow-up subject must be Re: <step-1 subject>" });
    }
  }

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

  // De-duplicate a reason reported twice (e.g. reply_freeze from state and touches).
  // Then report in the fixed PREFLIGHT_REFUSALS order.
  const seen = new Set<PreflightRefusal>();
  const ordered = verdicts
    .filter((v) => (seen.has(v.reason) ? false : (seen.add(v.reason), true)))
    .sort((a, b) => PREFLIGHT_REFUSALS.indexOf(a.reason) - PREFLIGHT_REFUSALS.indexOf(b.reason));
  return { verdicts: ordered, ok: ordered.length === 0, timezone, window, recomputedHash };
}

/** Refusals the send stage defers to the next window rather than holding. */
export const DEFERRABLE_REFUSALS: readonly PreflightRefusal[] = ["outside_window", "quota_exhausted"];
