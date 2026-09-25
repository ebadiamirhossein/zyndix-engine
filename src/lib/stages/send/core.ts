import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import type { JobQueue } from "@/lib/jobs/queue";
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
import { composeOutboundBody, sendIdempotencyKey } from "@/lib/sending/approval";
import { checkSenderDomain } from "@/lib/sending/guard";
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
import { raiseException } from "@/lib/webhooks/instantly";
import type { capacityDefaultsSchema } from "@/lib/validation/jsonb";
import type { Database, Json } from "@/types/database";
import type { DatabaseWithSending, DatabaseWithWebhooks, OutboxRowShape } from "@/types/database-extensions";
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
// into the bound sender's single-step Instantly campaign only inside the
// recipient's window; step >= 2 goes out with POST /api/v2/emails/reply from
// the same mailbox into step 1's thread.

export const SEND_JOB_TYPE = "send.email";
export const RECONCILE_JOB_TYPE = "send.reconcile";

type SendDb = SupabaseClient<DatabaseWithSending>;
type CapacityDefaults = z.infer<typeof capacityDefaultsSchema>;

export type SendDeps = {
  db: SendDb;
  instantly: Pick<
    InstantlyClient,
    "enrollLead" | "replyToEmail" | "getAccount" | "getWarmupAnalytics" | "findLeadInCampaign" | "listEmails"
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
): Promise<number | null> {
  // Ramp not started yet counts from today: the first reservation starts it.
  const quota = rampQuota(ramp, account.ramp_started_on ?? today, today);
  if (quota === null) return null;
  const day = await deps.ledger.getDay(account.id, today);
  const dayQuota = day?.quota ?? quota;
  return Math.min(quota, dayQuota) - (day?.used ?? 0) - (day?.reserved ?? 0);
}

async function providerHealth(
  deps: SendDeps,
  identifier: string,
  policy: SendPolicy,
): Promise<PreflightContext["providerHealth"]> {
  try {
    const account = await deps.instantly.getAccount(identifier);
    const warmup = await deps.instantly.getWarmupAnalytics([identifier]);
    const aggregate = warmup.aggregate_data[identifier] ?? warmup.aggregate_data[identifier.toLowerCase()] ?? null;
    const health = accountHealth(account, aggregate, { minWarmupScore: policy.min_warmup_score });
    return { verdict: health.verdict, warmupScore: health.warmupScore };
  } catch {
    // Unreadable health is not healthy: preflight refuses with sender_unhealthy.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

async function buildContext(
  deps: SendDeps,
  loaded: Loaded,
  sender: SendAccountRow,
  settings: { policy: SendPolicy; windows: SendWindowsConfig; ramp: CapacityDefaults["email_inbox"] },
  now: Date,
): Promise<{ ctx: PreflightContext; anchor: StepOneAnchor | null }> {
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
  // for it at all: no health/warmup read, no anchor lookup (U6 DoD).
  const senderPaused = sender.health !== "ok";
  const anchor = step > 1 ? await findStepOneAnchor(deps, lead, { providerLookup: !senderPaused }) : null;

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
    },
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
    providerHealth: senderPaused ? null : await providerHealth(deps, sender.identifier ?? "", settings.policy),
    suppression: { email: suppression.email, domain: suppression.domain },
    hasReply: (replyCount ?? 0) > 0,
    companyConflicts,
    capacityRemaining: await remainingCapacity(deps, sender, settings.ramp, today),
    threadAnchor: anchor ? { emailId: anchor.emailId, subject: anchor.subject } : null,
    policy: settings.policy,
    windows: settings.windows,
  };
  return { ctx, anchor };
}

type StepOneAnchor = { emailId: string; threadId: string | null; subject: string; outboxId: string };

/**
 * The Instantly email a follow-up replies to: step 1's sent email, looked up
 * against step 1's OWN mailbox (a property of the lead, not of whichever
 * sender this attempt carries — pinning is preflight's job). Taken from the
 * step-1 outbox row when known, else looked up with GET /api/v2/emails and
 * persisted. Null → thread_anchor_missing.
 */
async function findStepOneAnchor(
  deps: SendDeps,
  lead: LeadRow,
  options: { providerLookup: boolean },
): Promise<StepOneAnchor | null> {
  const { data: rows, error } = await deps.db
    .from("outbox")
    .select("*")
    .eq("lead_id", lead.id)
    .eq("operation", "enroll")
    .in("state", ["accepted", "reconciled_sent"])
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new SendStageError(`anchor outbox: ${error.message}`);
  const first = rows?.[0];
  if (!first) return null;

  const { data: stepOne, error: touchError } = await deps.db
    .from("touches")
    .select("id, subject")
    .eq("id", first.touch_id)
    .maybeSingle();
  if (touchError) throw new SendStageError(`anchor touch: ${touchError.message}`);
  if (!stepOne?.subject) return null;

  if (first.provider_email_id) {
    return { emailId: first.provider_email_id, threadId: first.provider_thread_id, subject: stepOne.subject, outboxId: first.id };
  }
  if (!options.providerLookup) return null;
  const stepOneSender = await loadAccount(deps.db, first.send_account_id);
  if (!lead.email || !stepOneSender?.identifier) return null;
  let page;
  try {
    page = await deps.instantly.listEmails({
      lead: lead.email,
      campaignId: first.provider_campaign_id ?? undefined,
      eaccount: stepOneSender.identifier,
      emailType: "sent",
      sortOrder: "asc",
      limit: 10,
    });
  } catch {
    return null;
  }
  const sent = page.items.find((e) => e.ue_type === 1 || e.ue_type === 3) ?? null;
  if (!sent) return null;
  await updateOutbox(deps.db, first.id, { provider_email_id: sent.id, provider_thread_id: sent.thread_id ?? null });
  const { error: touchUpdateError } = await deps.db
    .from("touches")
    .update({ provider_message_id: sent.id })
    .eq("id", first.touch_id);
  if (touchUpdateError) throw new SendStageError(`anchor touch update: ${touchUpdateError.message}`);
  return { emailId: sent.id, threadId: sent.thread_id ?? null, subject: stepOne.subject, outboxId: first.id };
}

async function loadSettings(deps: SendDeps) {
  const [policy, windows, capacity] = await Promise.all([
    deps.getActiveSetting("send_policy"),
    deps.getActiveSetting("send_windows"),
    deps.getActiveSetting("capacity_defaults"),
  ]);
  return {
    policy: policy.value as SendPolicy,
    windows: windows.value as SendWindowsConfig,
    ramp: (capacity.value as CapacityDefaults).email_inbox,
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
    // window that opens after the next UTC midnight.
    let window = result.window!;
    if (reasons.includes("quota_exhausted")) {
      const nextUtcDay = new Date(`${ledgerDate(new Date(now.getTime() + DAY_MS))}T00:00:00.000Z`);
      window = nextSendWindow(nextUtcDay, result.timezone!.timeZone, settings.windows);
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
  const sender = await pickSender(deps, loaded, settings.ramp, today);
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
  const quota = rampQuota(settings.ramp, sender.ramp_started_on ?? today, today);
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

  // 8. Outbox BEFORE the provider call.
  const operation = step === 1 ? "enroll" : "reply";
  const outbox = await writeDispatching(deps, existing, {
    touch_id: loaded.touch.id,
    lead_id: loaded.lead.id,
    send_account_id: sender.id,
    operation,
    idempotency_key: key,
    approval_hash: loaded.touch.approval_hash ?? "",
    reservation_id: reservationId,
    provider_campaign_id: step === 1 ? sender.instantly_campaign_id : null,
    reply_to_email_id: built.anchor?.emailId ?? null,
  });
  const { error: keyError } = await deps.db
    .from("touches")
    .update({ idempotency_key: key })
    .eq("id", loaded.touch.id);
  if (keyError) throw new SendStageError(`touch idempotency key: ${keyError.message}`);

  // 9. The provider call — the only line that can put mail in an inbox.
  // The text is the approved body plus the sender's signature, exactly as
  // hashed at approval (preflight has just re-verified the hash).
  const outboundText = composeOutboundBody(loaded.touch.body ?? "", sender.signature_text);
  try {
    if (operation === "enroll") {
      const enrolled = await deps.instantly.enrollLead({
        campaignId: sender.instantly_campaign_id!,
        lead: {
          email: loaded.lead.email!,
          first_name: loaded.lead.first_name ?? undefined,
          last_name: loaded.lead.last_name ?? undefined,
          company_name: loaded.company?.name ?? undefined,
          custom_variables: {
            zx_subject: loaded.touch.subject ?? "",
            zx_body: toHtmlBody(outboundText),
            zx_touch_id: loaded.touch.id,
          },
        },
        dedupe: "workspace",
      });
      await deps.hooks?.afterDispatch?.();
      if (enrolled.outcome === "created") {
        return accept(deps, loaded, outbox, reservationId, sender, { provider_lead_id: enrolled.leadId }, now);
      }
      if (enrolled.reason === "already_enrolled") {
        // Possibly our own earlier dispatch: reconcile, never resend.
        await markUncertain(deps, outbox, "skipped_already_enrolled", reservationId);
        return { kind: "uncertain", outboxId: outbox.id, reason: "skipped_already_enrolled" };
      }
      return fail(deps, loaded, outbox, reservationId, `enroll_skipped_${enrolled.reason}`);
    }

    // emails/reply addresses "the sender of the email being replied to" by
    // default — for our own step 1 that is our own mailbox (U6 drill, Session
    // 14). The lead goes in additional_recipients; there is no `to` field.
    const sent = await deps.instantly.replyToEmail({
      eaccount: sender.identifier!,
      replyToUuid: built.anchor!.emailId,
      subject: loaded.touch.subject ?? "",
      body: { html: toHtmlBody(outboundText), text: outboundText },
      additionalRecipients: [loaded.lead.email!],
    });
    await deps.hooks?.afterDispatch?.();
    const provider = { provider_email_id: sent.id, provider_thread_id: sent.thread_id ?? null };
    // Fail closed: an accepted follow-up that does not list the lead as a
    // recipient went somewhere else. It is never resent and never counted as
    // reaching the lead.
    if (!addressList(sent.to_address_email_list).includes(normalizeEmail(loaded.lead.email))) {
      return misaddressed(deps, loaded, outbox, reservationId, sender, provider, sent.to_address_email_list, now);
    }
    return accept(deps, loaded, outbox, reservationId, sender, provider, now);
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

/** Normalized addresses from a comma-separated list ("a@x.com, Name <b@y.com>"). */
export function addressList(value: string | null | undefined): string[] {
  return (value ?? "").match(/[^\s<>,;"]+@[^\s<>,;"]+/g)?.map((e) => normalizeEmail(e)) ?? [];
}

/**
 * The provider accepted a follow-up whose recipients do not include the lead.
 * Mail left, so the outbox is settled `accepted` (never resent) and capacity
 * is spent; the touch is `failed` because it did not reach the lead; an
 * escalated `reply_misaddressed` exception alerts the operator and the lead
 * goes to manual_hold.
 */
async function misaddressed(
  deps: SendDeps,
  loaded: Loaded,
  outbox: OutboxRowShape,
  reservationId: string,
  sender: SendAccountRow,
  provider: Partial<OutboxRowShape>,
  toAddresses: string | null | undefined,
  now: Date,
): Promise<SendOutcome> {
  const message = `reply_misaddressed: to=${toAddresses ?? "(none)"} expected=${normalizeEmail(loaded.lead.email)}`;
  await updateOutbox(deps.db, outbox.id, { ...provider, state: "accepted", settled_at: now.toISOString(), last_error: message.slice(0, 2000) });
  await deps.ledger.accept(reservationId);
  const { error } = await deps.db
    .from("touches")
    .update({
      status: "failed",
      sent_at: now.toISOString(),
      send_account_id: sender.id,
      ...(provider.provider_email_id ? { provider_message_id: provider.provider_email_id } : {}),
    })
    .eq("id", loaded.touch.id);
  if (error) throw new SendStageError(`touch misaddressed: ${error.message}`);
  const detail = {
    touch_id: loaded.touch.id,
    outbox_id: outbox.id,
    provider_email_id: provider.provider_email_id ?? null,
    to_address_email_list: toAddresses ?? null,
    expected: normalizeEmail(loaded.lead.email),
    sender: sender.identifier,
  };
  await raiseException(
    { db: deps.db as unknown as SupabaseClient<DatabaseWithWebhooks>, alert: deps.alert, now: deps.now },
    { kind: "reply_misaddressed", eventId: null, leadId: loaded.lead.id, escalate: true, detail },
  );
  await holdLead(deps, loaded.lead.id, "reply_misaddressed", detail);
  return { kind: "failed", outboxId: outbox.id, error: message };
}

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
