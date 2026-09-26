import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import type { JobQueue } from "@/lib/jobs/queue";
import { isCampaignPaused, readOperationsPause, type PauseState } from "@/lib/orchestrator/pause";
import type { JobContext } from "@/lib/jobs/registry";
import {
  accountHealth,
  InstantlyPermanentError,
  InstantlyRetryableError,
  InstantlyUncertainOutcomeError,
  type InstantlyClient,
} from "@/lib/integrations/instantly";
import type { CapacityLedger } from "@/lib/scheduler/ledger";
import { jitteredSendAt, ledgerDate, nextSendWindow, rampQuota } from "@/lib/scheduler/windows";
import { sendIdempotencyKey } from "@/lib/sending/approval";
import { bodyVariable, SUBJECT_VARIABLE } from "@/lib/sending/campaign-sequence";
import { checkSenderDomain } from "@/lib/sending/guard";
import {
  buildSequenceApprovalSnapshot,
  isSequenceSnapshot,
  SequenceShapeError,
  type SequenceApprovalSnapshot,
} from "@/lib/sending/sequence-approval";
import {
  DEFERRABLE_REFUSALS,
  preflight,
  type PreflightContext,
  type PreflightResult,
  type PreflightVerdict,
  type SendPolicy,
  type SendWindowsConfig,
} from "@/lib/sending/preflight";
import { checkSuppression, normalizeEmail } from "@/lib/sending/suppression";
import type { createStateStore } from "@/lib/state/core";
import { emailSequenceSchema, type capacityDefaultsSchema } from "@/lib/validation/jsonb";
import type { Database, Json } from "@/types/database";
import type { DatabaseWithEnrollments, DatabaseWithSending, OutboxRowShape } from "@/types/database-extensions";
import type { LeadState } from "@/types/enums";

// Send stage (09 §U5, brief §10). Runs as the U2 job `send.email`, one touch
// per job. The order is the safety argument:
//
//   load → pick sender (binding first) → preflight → reserve capacity
//   → preflight AGAIN on a fresh load (immediately before execution)
//   → bind sender → lead approved→queued → WRITE OUTBOX `dispatching`
//   → provider call → settle outbox + ledger + touch + lead
//
// Because the outbox row is written before the provider call, a worker that
// dies mid-flight leaves a `dispatching` row behind; the re-claimed job finds
// it and makes ZERO provider calls — it marks the row uncertain and hands it
// to send.reconcile. An uncertain outcome is never resent.
//
// Timing is engine-owned (operator decision, Session 11): step 1 is enrolled
// into the bound sender's Instantly campaign only inside the recipient's
// window. Steps >= 2 are that campaign's own sequence steps (09 §U6c): the
// enroll carries every approved step's composed body as a lead variable, and
// Instantly sends them in step 1's thread. The engine never sends a step >= 2
// itself: emails/reply kept our own mailbox in To (Sessions 14, 16), so that
// path is removed and runSendJob refuses followup_engine_send_disabled.

export const SEND_JOB_TYPE = "send.email";
export const RECONCILE_JOB_TYPE = "send.reconcile";

type SendDb = SupabaseClient<DatabaseWithSending>;
type CapacityDefaults = z.infer<typeof capacityDefaultsSchema>;

export type SendDeps = {
  db: SendDb;
  instantly: Pick<
    InstantlyClient,
    | "enrollLead"
    | "getAccount"
    | "getWarmupAnalytics"
    | "getCampaign"
    | "getAccountDailyAnalytics"
    | "findLeadInCampaign"
    | "listEmails"
  >;
  ledger: Pick<CapacityLedger, "reserve" | "release" | "accept" | "fail" | "markUncertain" | "reconcile" | "getDay">;
  queue: Pick<JobQueue, "enqueue">;
  transition: ReturnType<typeof createStateStore>["transition"];
  getActiveSetting: (key: string) => Promise<{ version: number; value: unknown }>;
  /** Operator-only alert (Telegram to TELEGRAM_ALLOWED_USER_IDS). */
  alert: (text: string) => Promise<void>;
  now?: () => Date;
  rng?: () => number;
  /** Test seams. Never set in production wiring. */
  hooks?: {
    afterReserve?: () => Promise<void>;
    afterDispatch?: () => Promise<void>;
  };
};

export type SendJobPayload = { touch_id: string };

export type SendOutcome =
  | { kind: "sent"; outboxId: string; operation: "enroll" | "reply" }
  | { kind: "uncertain"; outboxId: string; reason: string }
  | { kind: "failed"; outboxId: string; error: string }
  | { kind: "already"; outboxId: string; state: OutboxRowShape["state"] }
  | { kind: "refused"; verdicts: PreflightVerdict[]; hold: boolean }
  | { kind: "deferred"; verdicts: PreflightVerdict[]; runAfter: string };

/** Lead states in which another lead at the same company blocks a first touch. */
const ACTIVE_OUTREACH_STATES: readonly LeadState[] = [
  "queued",
  "sent",
  "replied",
  "classifying",
  "human_review",
  "meeting_booked",
  "handed_off",
];

const DAY_MS = 86_400_000;
/** 09 §U9: a paused send is re-checked in the first window at least this far ahead. */
const PAUSE_RECHECK_MS = 3_600_000;

export class SendStageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SendStageError";
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type TouchRow = DatabaseWithSending["public"]["Tables"]["touches"]["Row"];
type LeadRow = DatabaseWithSending["public"]["Tables"]["leads"]["Row"];
type SendAccountRow = DatabaseWithSending["public"]["Tables"]["send_accounts"]["Row"];
type CompanyRow = Database["public"]["Tables"]["companies"]["Row"];

type Loaded = {
  touch: TouchRow;
  lead: LeadRow;
  company: CompanyRow | null;
};

async function load(db: SendDb, touchId: string): Promise<Loaded> {
  const { data: touch, error: touchError } = await db.from("touches").select("*").eq("id", touchId).maybeSingle();
  if (touchError) throw new SendStageError(`load touch ${touchId}: ${touchError.message}`);
  if (!touch) throw new SendStageError(`touch not found: ${touchId}`);
  if (!touch.lead_id) throw new SendStageError(`touch ${touchId} has no lead`);

  const { data: lead, error: leadError } = await db.from("leads").select("*").eq("id", touch.lead_id).maybeSingle();
  if (leadError) throw new SendStageError(`load lead ${touch.lead_id}: ${leadError.message}`);
  if (!lead) throw new SendStageError(`lead not found: ${touch.lead_id}`);

  let company: CompanyRow | null = null;
  if (lead.company_id) {
    const { data, error } = await db.from("companies").select("*").eq("id", lead.company_id).maybeSingle();
    if (error) throw new SendStageError(`load company ${lead.company_id}: ${error.message}`);
    company = data;
  }
  return { touch, lead, company };
}

async function loadAccount(db: SendDb, id: string): Promise<SendAccountRow | null> {
  const { data, error } = await db.from("send_accounts").select("*").eq("id", id).maybeSingle();
  if (error) throw new SendStageError(`load send_account ${id}: ${error.message}`);
  return data;
}

async function getOutboxByKey(db: SendDb, key: string): Promise<OutboxRowShape | null> {
  const { data, error } = await db.from("outbox").select("*").eq("idempotency_key", key).maybeSingle();
  if (error) throw new SendStageError(`load outbox ${key}: ${error.message}`);
  return data;
}

async function updateOutbox(db: SendDb, id: string, patch: Partial<OutboxRowShape>): Promise<void> {
  const { error } = await db.from("outbox").update(patch).eq("id", id);
  if (error) throw new SendStageError(`update outbox ${id}: ${error.message}`);
}

async function logEvent(db: SendDb, leadId: string, event: string, detail: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("lead_events").insert({ lead_id: leadId, event, detail: detail as Json });
  if (error) throw new SendStageError(`lead_event ${event}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Sender selection, health and capacity
// ---------------------------------------------------------------------------

/**
 * The account this touch goes out from: the touch's own assignment if any,
 * else the lead's binding, else (step 1 only) the healthy allowed account
 * with the most room today. Pinning is judged by preflight, not here.
 */
async function pickSender(
  deps: SendDeps,
  loaded: Loaded,
  ramp: CapacityDefaults["email_inbox"],
  today: string,
  pause: PauseState,
): Promise<SendAccountRow | null> {
  const assigned = loaded.touch.send_account_id ?? loaded.lead.send_account_id;
  if (assigned) return loadAccount(deps.db, assigned);
  if ((loaded.touch.step_no ?? 1) > 1) return null;

  const { data, error } = await deps.db
    .from("send_accounts")
    .select("*")
    .eq("kind", "email")
    .eq("health", "ok")
    .not("instantly_campaign_id", "is", null)
    .order("identifier");
  if (error) throw new SendStageError(`list send_accounts: ${error.message}`);

  let best: { account: SendAccountRow; remaining: number } | null = null;
  for (const account of data ?? []) {
    if (!account.identifier || !checkSenderDomain(account.identifier).ok) continue;
    // 09 §U9: never pick into a paused Instantly campaign.
    if (isCampaignPaused(pause, account.instantly_campaign_id)) continue;
    const remaining = await remainingCapacity(deps, account, ramp, today);
    if (!best || (remaining ?? 0) > best.remaining) best = { account, remaining: remaining ?? 0 };
  }
  return best?.account ?? null;
}

async function remainingCapacity(
  deps: SendDeps,
  account: SendAccountRow,
  ramp: CapacityDefaults["email_inbox"],
  today: string,
  providerDailyLimit: number | null = null,
): Promise<number | null> {
  // Ramp not started yet counts from today: the first reservation starts it.
  const quota = engineQuota(rampQuota(ramp, account.ramp_started_on ?? today, today), providerDailyLimit);
  if (quota === null) return null;
  const day = await deps.ledger.getDay(account.id, today);
  const dayQuota = day?.quota ?? quota;
  return Math.min(quota, dayQuota) - (day?.used ?? 0) - (day?.reserved ?? 0);
}

/** 09 §U6c S20: the engine quota is min(ramp, Instantly daily_limit) when the limit is known. */
function engineQuota(ramp: number | null, providerDailyLimit: number | null): number | null {
  if (ramp === null) return null;
  return providerDailyLimit === null ? ramp : Math.min(ramp, providerDailyLimit);
}

async function providerHealth(
  deps: SendDeps,
  identifier: string,
  policy: SendPolicy,
): Promise<{ health: PreflightContext["providerHealth"]; dailyLimit: number | null }> {
  try {
    const account = await deps.instantly.getAccount(identifier);
    const warmup = await deps.instantly.getWarmupAnalytics([identifier]);
    const aggregate = warmup.aggregate_data[identifier] ?? warmup.aggregate_data[identifier.toLowerCase()] ?? null;
    const health = accountHealth(account, aggregate, { minWarmupScore: policy.min_warmup_score });
    const limit = account.daily_limit;
    return {
      health: { verdict: health.verdict, warmupScore: health.warmupScore },
      dailyLimit: typeof limit === "number" && Number.isFinite(limit) && limit >= 0 ? limit : null,
    };
  } catch {
    // Unreadable health is not healthy: preflight refuses with sender_unhealthy.
    return { health: null, dailyLimit: null };
  }
}

/** The live campaign's steps (09 §U6c S20). Null when unreadable → campaign_sequence_drift. */
async function campaignSteps(deps: SendDeps, campaignId: string | null): Promise<PreflightContext["campaignSteps"]> {
  if (!campaignId) return null;
  try {
    const campaign = await deps.instantly.getCampaign(campaignId);
    return campaign.sequences?.[0]?.steps ?? [];
  } catch {
    return null;
  }
}

/**
 * Campaign emails Instantly has sent today for this mailbox (UTC date; the
 * spec does not state the analytics timezone). No row for the date = 0.
 * Null when unreadable → sender_unhealthy provider_daily_unread.
 */
async function providerSentToday(deps: SendDeps, identifier: string, today: string): Promise<number | null> {
  try {
    const rows = await deps.instantly.getAccountDailyAnalytics({ emails: [identifier], startDate: today, endDate: today });
    const mine = rows.filter((r) => normalizeEmail(r.email_account) === normalizeEmail(identifier) && r.date.slice(0, 10) === today);
    return mine.reduce((sum, r) => sum + r.sent, 0);
  } catch {
    return null;
  }
}

const UNIT_MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: DAY_MS };

/**
 * Follow-ups Instantly will send today from this mailbox (09 §U6c S20): every
 * still-`approved` step >= 2 whose step 1 went out from this sender, due at
 * or before the end of today (UTC). Due = step 1's sent_at + the cumulative
 * delays bound in the step's own sequence snapshot. Overdue ones count too:
 * Instantly sends them as soon as it can.
 */
async function followupsDueToday(deps: SendDeps, senderId: string, now: Date): Promise<number> {
  const endOfDay = Date.parse(`${ledgerDate(now)}T23:59:59.999Z`);
  const { data: stepOnes, error } = await deps.db
    .from("touches")
    .select("lead_id, sent_at")
    .eq("send_account_id", senderId)
    .eq("step_no", 1)
    .eq("direction", "outbound")
    .eq("status", "sent")
    .not("sent_at", "is", null);
  if (error) throw new SendStageError(`follow-ups due: ${error.message}`);
  const sentAt = new Map((stepOnes ?? []).filter((t) => t.lead_id).map((t) => [t.lead_id!, Date.parse(t.sent_at!)]));
  if (sentAt.size === 0) return 0;

  const { data: followups, error: followError } = await deps.db
    .from("touches")
    .select("lead_id, step_no, approval_snapshot")
    .in("lead_id", [...sentAt.keys()])
    .gte("step_no", 2)
    .eq("direction", "outbound")
    .eq("status", "approved");
  if (followError) throw new SendStageError(`follow-ups due: ${followError.message}`);

  let due = 0;
  for (const touch of followups ?? []) {
    if (!touch.lead_id || !isSequenceSnapshot(touch.approval_snapshot)) continue;
    const steps = (touch.approval_snapshot as unknown as SequenceApprovalSnapshot).steps;
    const offset = steps
      .filter((s) => s.step_no <= (touch.step_no ?? 0))
      .reduce((ms, s) => ms + s.delay * (UNIT_MS[s.delay_unit] ?? DAY_MS), 0);
    if (sentAt.get(touch.lead_id)! + offset <= endOfDay) due += 1;
  }
  return due;
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

async function buildContext(
  deps: SendDeps,
  loaded: Loaded,
  sender: SendAccountRow,
  settings: { policy: SendPolicy; windows: SendWindowsConfig; ramp: CapacityDefaults["email_inbox"]; pause: PauseState },
  now: Date,
): Promise<{ ctx: PreflightContext }> {
  const { touch, lead, company } = loaded;
  const step = touch.step_no ?? 1;
  const today = ledgerDate(now);

  const suppression = await checkSuppression(deps.db as unknown as SupabaseClient<Database>, {
    email: lead.email,
    companyDomain: company?.domain ?? null,
  });

  const { count: replyCount, error: replyError } = await deps.db
    .from("touches")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", lead.id)
    .or("direction.eq.inbound,replied_at.not.is.null");
  if (replyError) throw new SendStageError(`reply check: ${replyError.message}`);

  let companyConflicts = 0;
  if (company && step === 1) {
    const since = new Date(now.getTime() - settings.policy.duplicate_company_window_days * DAY_MS).toISOString();
    const { data: others, error } = await deps.db
      .from("leads")
      .select("id, state, state_changed_at")
      .eq("company_id", company.id)
      .neq("id", lead.id)
      .in("state", ACTIVE_OUTREACH_STATES as LeadState[]);
    if (error) throw new SendStageError(`company conflict check: ${error.message}`);
    // `sent` only counts inside the window; the other active states always count.
    companyConflicts = (others ?? []).filter(
      (o) => o.state !== "sent" || (o.state_changed_at !== null && o.state_changed_at >= since),
    ).length;
  }

  // A sender the engine has paused (bounce auto-pause, stop_processing_stale)
  // is refused by preflight on `health` alone, so no provider call is made
  // for it at all (U6 DoD).
  const senderPaused = sender.health !== "ok";
  const provider = senderPaused
    ? { health: null, dailyLimit: null }
    : await providerHealth(deps, sender.identifier ?? "", settings.policy);
  const sequence = isSequenceSnapshot(touch.approval_snapshot) ? await loadApprovedSequence(deps, touch) : undefined;
  // 09 §U6c S20: the enroll-only reads, skipped for a paused sender. The
  // campaign is compared only against an approved sequence.
  const enrollReads = step === 1 && !senderPaused;
  const sentToday = enrollReads ? await providerSentToday(deps, sender.identifier ?? "", today) : null;

  const ctx: PreflightContext = {
    now,
    touch: {
      id: touch.id,
      step_no: touch.step_no,
      channel: touch.channel,
      direction: touch.direction,
      status: touch.status,
      subject: touch.subject,
      body: touch.body,
      prompt_version: touch.prompt_version,
      approval_hash: touch.approval_hash,
      claim_ledger: touch.claim_ledger,
      approval_snapshot: touch.approval_snapshot,
    },
    sequence,
    campaignSteps: enrollReads && sequence ? await campaignSteps(deps, sender.instantly_campaign_id) : null,
    providerDaily: enrollReads
      ? { dailyLimit: provider.dailyLimit, sentToday, followupsDueToday: await followupsDueToday(deps, sender.id, now) }
      : null,
    lead: {
      id: lead.id,
      state: lead.state as LeadState,
      email: lead.email,
      email_status: lead.email_status,
      email_verified_at: lead.email_verified_at,
      timezone: lead.timezone,
      do_not_contact: lead.do_not_contact,
      send_account_id: lead.send_account_id,
    },
    company: company ? { domain: company.domain, timezone: company.timezone, country: company.country } : null,
    sender: {
      id: sender.id,
      identifier: sender.identifier ?? "",
      health: sender.health,
      instantly_campaign_id: sender.instantly_campaign_id,
      signature_text: sender.signature_text,
    },
    providerHealth: provider.health,
    suppression: { email: suppression.email, domain: suppression.domain },
    hasReply: (replyCount ?? 0) > 0,
    companyConflicts,
    capacityRemaining: await remainingCapacity(deps, sender, settings.ramp, today, provider.dailyLimit),
    pause: {
      global: settings.pause.global,
      reason: settings.pause.reason,
      campaignPaused: isCampaignPaused(settings.pause, sender.instantly_campaign_id),
    },
    policy: settings.policy,
    windows: settings.windows,
  };
  return { ctx };
}

/**
 * 09 §U6c hash bridge: the steps sharing this touch's approval hash and the
 * ACTIVE email_sequence, for preflight to rebuild the sequence hash. Null
 * (→ stale_approval) when the setting is missing or invalid.
 */
async function loadApprovedSequence(
  deps: SendDeps,
  touch: Loaded["touch"],
): Promise<PreflightContext["sequence"]> {
  if (!touch.lead_id || !touch.approval_hash) return null;
  const { data, error } = await deps.db
    .from("touches")
    .select("id, step_no, channel, subject, body, prompt_version, claim_ledger, status")
    .eq("lead_id", touch.lead_id)
    .eq("approval_hash", touch.approval_hash);
  if (error) throw new SendStageError(`load sequence touches: ${error.message}`);
  let setting: { version: number; value: unknown };
  try {
    setting = await deps.getActiveSetting("email_sequence");
  } catch {
    return null;
  }
  const parsed = emailSequenceSchema.safeParse(setting.value);
  if (!parsed.success) return null;
  return { touches: data ?? [], setting: { version: setting.version, value: parsed.data } };
}

async function loadSettings(deps: SendDeps) {
  const [policy, windows, capacity, pause] = await Promise.all([
    deps.getActiveSetting("send_policy"),
    deps.getActiveSetting("send_windows"),
    deps.getActiveSetting("capacity_defaults"),
    // 09 §U9: a missing row = not paused; an unreadable one fails closed (paused).
    readOperationsPause(deps.getActiveSetting),
  ]);
  return {
    policy: policy.value as SendPolicy,
    windows: windows.value as SendWindowsConfig,
    ramp: (capacity.value as CapacityDefaults).email_inbox,
    pause,
  };
}

// ---------------------------------------------------------------------------
// Refusal handling
// ---------------------------------------------------------------------------

async function refuse(
  deps: SendDeps,
  loaded: Loaded,
  result: PreflightResult,
  reservationId: string | null,
  settings: { windows: SendWindowsConfig },
  now: Date,
  phase: "preflight" | "final_preflight",
): Promise<SendOutcome> {
  const { touch, lead } = loaded;
  if (reservationId) await deps.ledger.release(reservationId);

  const reasons = result.verdicts.map((v) => v.reason);
  const deferrable =
    result.window !== null && reasons.length > 0 && reasons.every((r) => DEFERRABLE_REFUSALS.includes(r));

  if (deferrable) {
    // The window or the day's quota will come round again: defer to the next
    // window (jittered). Deferral requires a resolved timezone — see below.
    // Quota is counted per UTC day, so an exhausted day defers to the first
    // window that opens after the next UTC midnight. Instantly's daily_limit
    // (provider_daily_limit) is judged per UTC date too.
    let window = result.window!;
    if (reasons.includes("quota_exhausted") || reasons.includes("provider_daily_limit")) {
      const nextUtcDay = new Date(`${ledgerDate(new Date(now.getTime() + DAY_MS))}T00:00:00.000Z`);
      window = nextSendWindow(nextUtcDay, result.timezone!.timeZone, settings.windows);
    } else if (reasons.includes("operations_paused") || reasons.includes("campaign_paused")) {
      // 09 §U9: a pause is lifted by the operator, not by the clock. Re-check
      // no sooner than PAUSE_RECHECK_MS, so a paused send is not re-queued
      // (with its provider reads) every tick of an open window.
      window = nextSendWindow(new Date(now.getTime() + PAUSE_RECHECK_MS), result.timezone!.timeZone, settings.windows);
    }
    const runAfter = jitteredSendAt(window, settings.windows.jitter_minutes, deps.rng).sendAt.toISOString();
    await deps.queue.enqueue({
      type: SEND_JOB_TYPE,
      payload: { touch_id: touch.id },
      runAfter,
      idempotencyKey: `${sendIdempotencyKey(touch.id, touch.approval_hash ?? "none")}:at:${runAfter}`,
    });
    await logEvent(deps.db, lead.id, "send_deferred", {
      touch_id: touch.id,
      verdicts: result.verdicts,
      run_after: runAfter,
      phase,
    });
    return { kind: "deferred", verdicts: result.verdicts, runAfter };
  }

  // Everything else is a hold: no re-enqueue. timezone_unknown in particular
  // must never be deferred — with no zone there is no next window, so a retry
  // would loop forever. The operator is told.
  await logEvent(deps.db, lead.id, "send_refused", {
    touch_id: touch.id,
    step: touch.step_no ?? 1,
    verdicts: result.verdicts,
    phase,
  });
  const hold = true;
  if (reasons.includes("timezone_unknown")) {
    await deps.alert(
      `⏸ Send held: timezone_unknown\nlead ${lead.id} · touch ${touch.id}\n` +
        `No lead/company timezone and the HQ country has no single zone. Set leads.timezone, then re-queue.`,
    );
  }
  return { kind: "refused", verdicts: result.verdicts, hold };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export async function runSendJob(deps: SendDeps, job: JobContext<SendJobPayload>): Promise<SendOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const settings = await loadSettings(deps);
  let loaded = await load(deps.db, job.payload.touch_id);
  const step = loaded.touch.step_no ?? 1;
  const key = sendIdempotencyKey(loaded.touch.id, loaded.touch.approval_hash ?? "none");

  // 0. 09 §U6c S20: a step >= 2 is an Instantly campaign step. The engine
  //    never sends it — refused before any sender pick, provider call or
  //    reservation (a hold: there is no window in which it becomes sendable).
  if (step > 1) {
    const disabled: PreflightResult = {
      verdicts: [{ reason: "followup_engine_send_disabled", detail: { step } }],
      ok: false,
      timezone: null,
      window: null,
      recomputedHash: "",
    };
    return refuse(deps, loaded, disabled, null, settings, now, "preflight");
  }

  // 1. Replay protection. Anything past `retry_wait` means a dispatch may have
  //    left: never call the provider again for this key.
  const existing = await getOutboxByKey(deps.db, key);
  if (existing && existing.state === "dispatching") {
    await markUncertain(deps, existing, "worker_crash_mid_dispatch", null);
    return { kind: "uncertain", outboxId: existing.id, reason: "worker_crash_mid_dispatch" };
  }
  if (existing && existing.state !== "retry_wait") {
    return { kind: "already", outboxId: existing.id, state: existing.state };
  }

  // 2. Sender.
  const today = ledgerDate(now);
  const sender = await pickSender(deps, loaded, settings.ramp, today, settings.pause);
  if (!sender) {
    const result: PreflightResult = {
      verdicts: [{ reason: "sender_unhealthy", detail: { reasons: ["no_eligible_send_account"] } }],
      ok: false,
      timezone: null,
      window: null,
      recomputedHash: "",
    };
    return refuse(deps, loaded, result, null, settings, now, "preflight");
  }

  // 3. Preflight.
  let built = await buildContext(deps, loaded, sender, settings, now);
  let result = preflight(built.ctx);
  if (!result.ok) return refuse(deps, loaded, result, existing?.reservation_id ?? null, settings, now, "preflight");

  // 4. Reserve capacity on the bound account. Keyed per job so a retried or
  //    re-claimed run gets the same reservation back.
  if (!sender.ramp_started_on) {
    const { error } = await deps.db
      .from("send_accounts")
      .update({ ramp_started_on: today })
      .eq("id", sender.id)
      .is("ramp_started_on", null);
    if (error) throw new SendStageError(`start ramp: ${error.message}`);
  }
  const quota = engineQuota(
    rampQuota(settings.ramp, sender.ramp_started_on ?? today, today),
    built.ctx.providerDaily?.dailyLimit ?? null,
  );
  if (quota === null) throw new SendStageError(`ramp quota unknown for ${sender.id}`);
  const reservation = await deps.ledger.reserve({
    sendAccountId: sender.id,
    date: today,
    quota,
    idempotencyKey: `${key}:job:${job.id}`,
  });
  if (!reservation.ok) {
    const quotaResult: PreflightResult = {
      ...result,
      ok: false,
      verdicts: [{ reason: "quota_exhausted", detail: { snapshot: reservation.snapshot } }],
    };
    return refuse(deps, loaded, quotaResult, null, settings, now, "preflight");
  }
  if (reservation.reservation.state !== "reserved") {
    throw new SendStageError(
      `reservation ${reservation.reservation.id} is ${reservation.reservation.state}, expected reserved`,
    );
  }
  const reservationId = reservation.reservation.id;
  await deps.hooks?.afterReserve?.();

  // 5. Preflight again on a fresh load, immediately before execution.
  loaded = await load(deps.db, job.payload.touch_id);
  built = await buildContext(deps, loaded, sender, settings, now);
  result = preflight(built.ctx);
  if (!result.ok) return refuse(deps, loaded, result, reservationId, settings, now, "final_preflight");

  // 6. Bind the sender (first send only). A lost race is sender_mismatch.
  if (!loaded.lead.send_account_id) {
    const { data: bound, error } = await deps.db
      .from("leads")
      .update({ send_account_id: sender.id })
      .eq("id", loaded.lead.id)
      .is("send_account_id", null)
      .select("send_account_id");
    if (error) throw new SendStageError(`bind sender: ${error.message}`);
    if (!bound || bound.length === 0) {
      const fresh = await load(deps.db, job.payload.touch_id);
      if (fresh.lead.send_account_id !== sender.id) {
        const mismatch: PreflightResult = {
          ...result,
          ok: false,
          verdicts: [{ reason: "sender_mismatch", detail: { bound: fresh.lead.send_account_id, attempted: sender.id } }],
        };
        return refuse(deps, fresh, mismatch, reservationId, settings, now, "final_preflight");
      }
    } else {
      await logEvent(deps.db, loaded.lead.id, "sender_bound", {
        send_account_id: sender.id,
        identifier: sender.identifier,
        touch_id: loaded.touch.id,
      });
    }
  }

  // 7. Lead approved → queued (step 1).
  if (step === 1 && loaded.lead.state === "approved") {
    await deps.transition(loaded.lead.id, "approved", "queued", "send_queued", {
      touch_id: loaded.touch.id,
      send_account_id: sender.id,
      time_zone: result.timezone?.timeZone ?? null,
      time_zone_source: result.timezone?.source ?? null,
      // How leads.timezone itself was derived (0009), e.g. hq_state.
      lead_timezone_source: loaded.lead.timezone_source ?? null,
    });
  }

  // 8. The lead variables: every step's text exactly as the approval hash
  //    binds it (approved body + mailbox signature, footer included). Rebuilt
  //    from the same touches and setting preflight has just verified.
  const variables = enrollVariables(built.ctx, loaded.touch.id);
  if (!variables.ok) {
    const incomplete: PreflightResult = {
      ...result,
      ok: false,
      verdicts: [{ reason: "sequence_incomplete", detail: { reason: variables.reason } }],
    };
    return refuse(deps, loaded, incomplete, reservationId, settings, now, "final_preflight");
  }

  // 9. Outbox BEFORE the provider call.
  const operation = "enroll";
  const outbox = await writeDispatching(deps, existing, {
    touch_id: loaded.touch.id,
    lead_id: loaded.lead.id,
    send_account_id: sender.id,
    operation,
    idempotency_key: key,
    approval_hash: loaded.touch.approval_hash ?? "",
    reservation_id: reservationId,
    provider_campaign_id: sender.instantly_campaign_id,
    reply_to_email_id: null,
  });
  const { error: keyError } = await deps.db
    .from("touches")
    .update({ idempotency_key: key })
    .eq("id", loaded.touch.id);
  if (keyError) throw new SendStageError(`touch idempotency key: ${keyError.message}`);

  // 10. The provider call — the only line that can put mail in an inbox.
  // Instantly sends step 1 now (inside the window) and every later step on
  // the campaign's own delays, from these variables alone.
  try {
    const enrolled = await deps.instantly.enrollLead({
      campaignId: sender.instantly_campaign_id!,
      lead: {
        email: loaded.lead.email!,
        first_name: loaded.lead.first_name ?? undefined,
        last_name: loaded.lead.last_name ?? undefined,
        company_name: loaded.company?.name ?? undefined,
        custom_variables: variables.values,
      },
      dedupe: "workspace",
    });
    await deps.hooks?.afterDispatch?.();
    if (enrolled.outcome === "created") {
      await recordEnrollment(deps, loaded, sender.id, sender.instantly_campaign_id!, enrolled.leadId);
      return accept(deps, loaded, outbox, reservationId, sender, { provider_lead_id: enrolled.leadId }, now);
    }
    if (enrolled.reason === "already_enrolled") {
      // Possibly our own earlier dispatch: reconcile, never resend.
      await markUncertain(deps, outbox, "skipped_already_enrolled", reservationId);
      return { kind: "uncertain", outboxId: outbox.id, reason: "skipped_already_enrolled" };
    }
    return fail(deps, loaded, outbox, reservationId, `enroll_skipped_${enrolled.reason}`);
  } catch (error) {
    if (error instanceof InstantlyUncertainOutcomeError) {
      await markUncertain(deps, outbox, error.reason, reservationId, error.fingerprint);
      return { kind: "uncertain", outboxId: outbox.id, reason: error.reason };
    }
    if (error instanceof InstantlyRetryableError) {
      // Nothing reached the provider. Keep the reservation; U2 retries the job.
      await updateOutbox(deps.db, outbox.id, { state: "retry_wait", last_error: error.message.slice(0, 2000) });
      throw error;
    }
    if (error instanceof InstantlyPermanentError) {
      return fail(deps, loaded, outbox, reservationId, `${error.kind}: ${error.message}`);
    }
    // Anything else after the outbox write (including a crash hook) leaves the
    // row `dispatching`; the re-claimed job turns it uncertain. Rethrow.
    throw error;
  }
}

/**
 * The enroll's custom_variables (09 §U6c): zx_subject, zx_body (step 1),
 * zx_body_N (each follow-up), zx_touch_id — every body composed exactly as
 * buildSequenceApprovalSnapshot hashes it, then rendered as HTML line breaks.
 * Not ok if the sequence cannot be rebuilt or any variable is blank: Instantly
 * would send a blank email (the blank-email guard, again at the last moment).
 */
export function enrollVariables(
  ctx: PreflightContext,
  touchId: string,
): { ok: true; values: Record<string, string>; snapshot: SequenceApprovalSnapshot } | { ok: false; reason: string } {
  if (!ctx.sequence) return { ok: false, reason: "sequence_not_loaded" };
  let snapshot: SequenceApprovalSnapshot;
  try {
    snapshot = buildSequenceApprovalSnapshot({
      lead: ctx.lead,
      sender: ctx.sender,
      sequence: ctx.sequence.setting,
      touches: ctx.sequence.touches,
    });
  } catch (error) {
    if (error instanceof SequenceShapeError) return { ok: false, reason: `sequence_not_rebuildable: ${error.message}` };
    throw error;
  }
  const values: Record<string, string> = { [SUBJECT_VARIABLE]: snapshot.steps[0]!.subject, zx_touch_id: touchId };
  for (const step of snapshot.steps) values[bodyVariable(step.step_no)] = toHtmlBody(step.body);
  const blank = Object.entries(values).filter(([, v]) => !v.replace(/<br\/>/g, "").trim());
  if (blank.length > 0) return { ok: false, reason: `blank_variable: ${blank.map(([k]) => k).join(",")}` };
  return { ok: true, values, snapshot };
}

/**
 * The engine's record of the enrollment (09 §U6c, 0009d). Written once the
 * provider accepted (or reconcile found) the lead. The live-lead unique index
 * turns a second active row into an error, never a second sequence.
 */
async function recordEnrollment(
  deps: SendDeps,
  loaded: Loaded,
  sendAccountId: string,
  campaignId: string,
  providerLeadId: string | null,
): Promise<void> {
  const snapshot = loaded.touch.approval_snapshot;
  if (!isSequenceSnapshot(snapshot) || !loaded.touch.approval_hash) return;
  const db = deps.db as unknown as SupabaseClient<DatabaseWithEnrollments>;
  const { error } = await db.from("instantly_enrollments").insert({
    lead_id: loaded.lead.id,
    send_account_id: sendAccountId,
    campaign_id: campaignId,
    provider_lead_id: providerLeadId,
    sequence_hash: loaded.touch.approval_hash,
    steps_total: (snapshot as unknown as SequenceApprovalSnapshot).steps.length,
    state: "active",
  });
  if (error) throw new SendStageError(`record enrollment for lead ${loaded.lead.id}: ${error.message}`);
}

function toHtmlBody(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/\r?\n/g, "<br/>");
}

async function writeDispatching(
  deps: SendDeps,
  existing: OutboxRowShape | null,
  row: Pick<
    OutboxRowShape,
    | "touch_id"
    | "lead_id"
    | "send_account_id"
    | "operation"
    | "idempotency_key"
    | "approval_hash"
    | "reservation_id"
    | "provider_campaign_id"
    | "reply_to_email_id"
  >,
): Promise<OutboxRowShape> {
  const now = new Date().toISOString();
  if (existing) {
    // retry_wait → dispatching, fenced on the state it was read in.
    const { data, error } = await deps.db
      .from("outbox")
      .update({ ...row, state: "dispatching", dispatch_count: existing.dispatch_count + 1, dispatched_at: now })
      .eq("id", existing.id)
      .eq("state", "retry_wait")
      .select("*");
    if (error) throw new SendStageError(`outbox re-dispatch: ${error.message}`);
    if (!data || data.length !== 1) throw new SendStageError(`outbox ${existing.id} changed under us; not dispatching`);
    return data[0];
  }
  const { data, error } = await deps.db
    .from("outbox")
    .insert({ ...row, state: "dispatching", dispatch_count: 1, dispatched_at: now })
    .select("*")
    .single();
  if (error || !data) {
    // 23505: another worker wrote this key first — it owns the dispatch.
    throw new SendStageError(`outbox insert: ${error?.message ?? "no row"}`);
  }
  return data;
}

async function accept(
  deps: SendDeps,
  loaded: Loaded,
  outbox: OutboxRowShape,
  reservationId: string,
  sender: SendAccountRow,
  provider: Partial<OutboxRowShape>,
  now: Date,
): Promise<SendOutcome> {
  await updateOutbox(deps.db, outbox.id, { ...provider, state: "accepted", settled_at: now.toISOString(), last_error: null });
  await deps.ledger.accept(reservationId);
  await markTouchSent(deps, loaded.touch.id, sender.id, provider.provider_email_id ?? null, now);
  await leadSent(deps, loaded, outbox, "send_accepted");
  return { kind: "sent", outboxId: outbox.id, operation: outbox.operation };
}

/** Moved to lib/sending/recipient-check.ts (S21); re-exported for the drill/spike scripts. */
export { addressList } from "@/lib/sending/recipient-check";

async function markTouchSent(deps: SendDeps, touchId: string, senderId: string, emailId: string | null, now: Date) {
  const { error } = await deps.db
    .from("touches")
    .update({
      status: "sent",
      sent_at: now.toISOString(),
      send_account_id: senderId,
      ...(emailId ? { provider_message_id: emailId } : {}),
    })
    .eq("id", touchId);
  if (error) throw new SendStageError(`touch sent: ${error.message}`);
}

async function leadSent(deps: SendDeps, loaded: Loaded, outbox: OutboxRowShape, event: string): Promise<void> {
  const { data: lead, error } = await deps.db.from("leads").select("state").eq("id", loaded.lead.id).maybeSingle();
  if (error) throw new SendStageError(`lead reload: ${error.message}`);
  if (lead?.state === "queued") {
    await deps.transition(loaded.lead.id, "queued", "sent", event, {
      touch_id: loaded.touch.id,
      outbox_id: outbox.id,
      operation: outbox.operation,
    });
  } else {
    await logEvent(deps.db, loaded.lead.id, event, {
      touch_id: loaded.touch.id,
      outbox_id: outbox.id,
      operation: outbox.operation,
      step: loaded.touch.step_no ?? 1,
    });
  }
}

async function markUncertain(
  deps: SendDeps,
  outbox: OutboxRowShape,
  reason: string,
  reservationId: string | null,
  fingerprint?: Record<string, string>,
): Promise<void> {
  const { data, error } = await deps.db
    .from("outbox")
    .update({ state: "uncertain", uncertain_reason: reason, fingerprint: (fingerprint ?? null) as Json })
    .eq("id", outbox.id)
    .eq("state", "dispatching")
    .select("id");
  if (error) throw new SendStageError(`outbox uncertain: ${error.message}`);
  const reservation = reservationId ?? outbox.reservation_id;
  if (data && data.length === 1 && reservation) await deps.ledger.markUncertain(reservation);
  const { error: touchError } = await deps.db.from("touches").update({ status: "uncertain" }).eq("id", outbox.touch_id);
  if (touchError) throw new SendStageError(`touch uncertain: ${touchError.message}`);
  await logEvent(deps.db, outbox.lead_id, "send_uncertain", { outbox_id: outbox.id, reason, touch_id: outbox.touch_id });
  await deps.queue.enqueue({
    type: RECONCILE_JOB_TYPE,
    payload: { outbox_id: outbox.id },
    idempotencyKey: `reconcile:${outbox.id}`,
  });
}

async function fail(
  deps: SendDeps,
  loaded: Loaded,
  outbox: OutboxRowShape,
  reservationId: string,
  message: string,
): Promise<SendOutcome> {
  await updateOutbox(deps.db, outbox.id, {
    state: "failed",
    last_error: message.slice(0, 2000),
    settled_at: new Date().toISOString(),
  });
  await deps.ledger.fail(reservationId);
  const { error } = await deps.db.from("touches").update({ status: "failed" }).eq("id", loaded.touch.id);
  if (error) throw new SendStageError(`touch failed: ${error.message}`);
  await holdLead(deps, loaded.lead.id, "send_failed", { touch_id: loaded.touch.id, outbox_id: outbox.id, error: message });
  await deps.alert(`⛔ Send failed permanently\nlead ${loaded.lead.id} · touch ${loaded.touch.id}\n${message.slice(0, 300)}`);
  return { kind: "failed", outboxId: outbox.id, error: message };
}

/** queued / sent → manual_hold: the only legal exit when a send cannot complete. */
export async function holdLead(
  deps: Pick<SendDeps, "db" | "transition">,
  leadId: string,
  event: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { data: lead, error } = await deps.db.from("leads").select("state").eq("id", leadId).maybeSingle();
  if (error) throw new SendStageError(`lead reload: ${error.message}`);
  const state = lead?.state as LeadState | undefined;
  if (state && state !== "manual_hold" && state !== "suppressed") {
    await deps.transition(leadId, state, "manual_hold", event, detail);
  }
}

// ---------------------------------------------------------------------------
// Reconcile (send.reconcile)
// ---------------------------------------------------------------------------

export type ReconcilePayload = { outbox_id: string };

export type ReconcileOutcome =
  | { kind: "reconciled_sent"; outboxId: string }
  | { kind: "reconciled_not_sent"; outboxId: string }
  | { kind: "already"; outboxId: string; state: OutboxRowShape["state"] };

/**
 * Resolves an uncertain dispatch by asking the provider, never by resending.
 * Found → sent. Proven absent → not sent, and the lead goes to manual_hold for
 * the operator: an automatic resend after a proven absence is still a policy
 * decision this engine does not make on its own. A provider error rethrows so
 * the job retries and the row stays uncertain.
 */
export async function runReconcileJob(
  deps: SendDeps,
  job: JobContext<ReconcilePayload>,
): Promise<ReconcileOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const { data: outbox, error } = await deps.db.from("outbox").select("*").eq("id", job.payload.outbox_id).maybeSingle();
  if (error) throw new SendStageError(`reconcile load: ${error.message}`);
  if (!outbox) throw new SendStageError(`outbox not found: ${job.payload.outbox_id}`);
  if (outbox.state !== "uncertain") return { kind: "already", outboxId: outbox.id, state: outbox.state };

  const loaded = await load(deps.db, outbox.touch_id);
  const sender = await loadAccount(deps.db, outbox.send_account_id);
  if (!sender?.identifier || !loaded.lead.email) {
    throw new SendStageError(`reconcile ${outbox.id}: sender or recipient missing`);
  }

  let found: Partial<OutboxRowShape> | null = null;
  if (outbox.operation === "enroll") {
    if (!outbox.provider_campaign_id) throw new SendStageError(`reconcile ${outbox.id}: no campaign id`);
    const lead = await deps.instantly.findLeadInCampaign(outbox.provider_campaign_id, loaded.lead.email);
    if (lead) found = { provider_lead_id: lead.id };
  } else {
    const page = await deps.instantly.listEmails({
      lead: loaded.lead.email,
      eaccount: sender.identifier,
      emailType: "sent",
      minTimestampCreated: outbox.dispatched_at ?? undefined,
      limit: 20,
    });
    const subject = (loaded.touch.subject ?? "").trim();
    const match = page.items.find((e) => e.subject.trim() === subject && e.id !== outbox.reply_to_email_id);
    if (match) found = { provider_email_id: match.id, provider_thread_id: match.thread_id ?? null };
  }

  const fenced = async (state: "reconciled_sent" | "reconciled_not_sent", patch: Partial<OutboxRowShape>) => {
    const { data, error: updateError } = await deps.db
      .from("outbox")
      .update({ ...patch, state, settled_at: now.toISOString() })
      .eq("id", outbox.id)
      .eq("state", "uncertain")
      .select("id");
    if (updateError) throw new SendStageError(`reconcile update: ${updateError.message}`);
    return (data ?? []).length === 1;
  };

  if (found) {
    if (!(await fenced("reconciled_sent", found))) return { kind: "already", outboxId: outbox.id, state: outbox.state };
    if (outbox.operation === "enroll") {
      await recordEnrollment(deps, loaded, outbox.send_account_id, outbox.provider_campaign_id!, found.provider_lead_id ?? null);
    }
    if (outbox.reservation_id) await deps.ledger.reconcile(outbox.reservation_id, "sent");
    await markTouchSent(deps, outbox.touch_id, outbox.send_account_id, found.provider_email_id ?? null, now);
    await leadSent(deps, loaded, outbox, "send_reconciled_sent");
    return { kind: "reconciled_sent", outboxId: outbox.id };
  }

  if (!(await fenced("reconciled_not_sent", {}))) return { kind: "already", outboxId: outbox.id, state: outbox.state };
  if (outbox.reservation_id) await deps.ledger.reconcile(outbox.reservation_id, "not_sent");
  const { error: touchError } = await deps.db.from("touches").update({ status: "failed" }).eq("id", outbox.touch_id);
  if (touchError) throw new SendStageError(`reconcile touch: ${touchError.message}`);
  await holdLead(deps, outbox.lead_id, "send_reconciled_not_sent", { outbox_id: outbox.id, touch_id: outbox.touch_id });
  await deps.alert(
    `⚠️ Uncertain send reconciled as NOT sent\nlead ${outbox.lead_id} · touch ${outbox.touch_id}\n` +
      `Lead is on manual_hold. Nothing is resent automatically.`,
  );
  return { kind: "reconciled_not_sent", outboxId: outbox.id };
}

/** Enqueues the first send attempt for an approved touch. U9's orchestrator is the production caller. */
export async function enqueueSend(
  deps: Pick<SendDeps, "queue">,
  touch: { id: string; approval_hash: string | null },
  runAfter?: string,
) {
  if (!touch.approval_hash) throw new SendStageError(`touch ${touch.id} has no approval binding`);
  return deps.queue.enqueue({
    type: SEND_JOB_TYPE,
    payload: { touch_id: touch.id },
    ...(runAfter ? { runAfter } : {}),
    idempotencyKey: sendIdempotencyKey(touch.id, touch.approval_hash),
  });
}
