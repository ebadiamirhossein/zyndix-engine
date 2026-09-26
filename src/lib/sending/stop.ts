import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type InstantlyClient,
  InstantlyPermanentError,
  InstantlyRetryableError,
  InstantlyUncertainOutcomeError,
} from "@/lib/integrations/instantly";
import type { createStateStore } from "@/lib/state/core";
import { raiseException, WebhookProcessingError } from "@/lib/webhooks/exceptions";
import type { Json } from "@/types/database";
import type {
  DatabaseWithEnrollments,
  DatabaseWithWebhooks,
  InstantlyEnrollmentRowShape,
} from "@/types/database-extensions";
import type { LeadState } from "@/types/enums";

// Stopping an Instantly-owned sequence (09 §U6c scope 4, S21).
//
// Follow-ups (step >= 2) are Instantly campaign steps, so stopping a lead means
// removing it from the campaign — Instantly has no per-lead pause:
//
//   1. engine side first: the lead's unsent follow-up touches → killed, and
//      any queued job on them cancelled;
//   2. enrollment → stopping;
//   3. DELETE /leads/{id}; confirm with GET /leads/{id} 404 AND leads/list 0;
//   4. enrollment → removed.
//
// A DELETE that times out or 5xxs may have been applied: the lead is read
// first (GET), never assumed gone and never blindly deleted again. At most two
// DELETE attempts; a stop still unconfirmed after that is `stop_failed`:
// escalated, and the sender's campaign is paused so nothing further can go
// out. Provider failures return an outcome, never throw — only DB errors do,
// and every step is idempotent, so a webhook replay repeats safely.
//
// Sender pause (operator decision, Session 17): pause the campaign FIRST, then
// stop every in-flight lead of that sender and hold it. A resume never
// silently continues old sequences.

type AnyDb = SupabaseClient<DatabaseWithWebhooks>;
type EnrollDb = SupabaseClient<DatabaseWithEnrollments>;

export type StopReason =
  | "reply_received"
  | "unsubscribed"
  | "bounced"
  | "manual_hold"
  | "suppressed"
  | "sender_paused"
  | "meeting_booked"
  | "recipient_misaddressed"
  | "recipient_check_unreadable"
  | "stopped_lead_active";

export type StopDeps = {
  db: AnyDb;
  instantly: Pick<InstantlyClient, "pauseCampaign" | "deleteLead" | "getLead" | "findLeadInCampaign">;
  transition: ReturnType<typeof createStateStore>["transition"];
  alert: (text: string) => Promise<void>;
  now?: () => Date;
};

export type SenderRef = { id: string; identifier: string | null; instantly_campaign_id: string | null };

export type StopOutcome = {
  outcome: "no_enrollment" | "removed" | "already_removed" | "stop_failed";
  killed_touches: number;
  cancelled_jobs: number;
  /** DELETE attempts made in this call. */
  attempts: number;
  enrollment_id?: string;
  error?: string;
};

export class StopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopError";
  }
}

export const MAX_DELETE_ATTEMPTS = 2;
const LIVE_ENROLLMENT_STATES = ["active", "stopping", "stop_failed"] as const;
const KILLABLE_FOLLOWUP_STATUSES = ["drafted", "pending_approval", "approved", "edited"];
/** Lead states a sender-pause cascade moves to manual_hold (operator, Session 17). */
const HOLD_ON_SENDER_PAUSE: readonly LeadState[] = ["queued", "sent"];

function clock(deps: Pick<StopDeps, "now">): Date {
  return (deps.now ?? (() => new Date()))();
}

function enrollDb(db: AnyDb): EnrollDb {
  return db as unknown as EnrollDb;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// stopSequence
// ---------------------------------------------------------------------------

export async function stopSequence(
  deps: StopDeps,
  leadId: string,
  reason: StopReason,
  opts: {
    /** Set by the sender-pause cascade: a failure here must not pause (and cascade) again. */
    noPause?: boolean;
    eventId?: string | null;
  } = {},
): Promise<StopOutcome> {
  const now = clock(deps);
  const frozen = await killFollowups(deps.db, leadId, now);

  const enrollment = await liveEnrollment(deps.db, leadId);
  if (!enrollment) {
    const removed = await hasRemovedEnrollment(deps.db, leadId);
    return { outcome: removed ? "already_removed" : "no_enrollment", ...frozen, attempts: 0 };
  }

  const { error: fenceError } = await enrollDb(deps.db)
    .from("instantly_enrollments")
    .update({ state: "stopping", stop_reason: enrollment.stop_reason ?? reason })
    .eq("id", enrollment.id)
    .in("state", [...LIVE_ENROLLMENT_STATES]);
  if (fenceError) throw new StopError(`enrollment stopping: ${fenceError.message}`);

  const email = await leadEmail(deps.db, leadId);
  const result = await deleteAndConfirm(deps, enrollment, email);
  const checkedAt = clock(deps).toISOString();

  if (result.ok) {
    const { error } = await enrollDb(deps.db)
      .from("instantly_enrollments")
      .update({ state: "removed", removed_at: checkedAt, last_checked_at: checkedAt })
      .eq("id", enrollment.id);
    if (error) throw new StopError(`enrollment removed: ${error.message}`);
    await logEvent(deps.db, leadId, "sequence_stopped", {
      reason,
      enrollment_id: enrollment.id,
      campaign_id: enrollment.campaign_id,
      provider_lead_id: result.providerLeadId,
      attempts: result.attempts,
      killed_touches: frozen.killed_touches,
      cancelled_jobs: frozen.cancelled_jobs,
      ...(opts.eventId ? { webhook_event_id: opts.eventId } : {}),
    });
    return { outcome: "removed", ...frozen, attempts: result.attempts, enrollment_id: enrollment.id };
  }

  const { error } = await enrollDb(deps.db)
    .from("instantly_enrollments")
    .update({ state: "stop_failed", last_checked_at: checkedAt })
    .eq("id", enrollment.id);
  if (error) throw new StopError(`enrollment stop_failed: ${error.message}`);
  await logEvent(deps.db, leadId, "sequence_stop_failed", {
    reason,
    enrollment_id: enrollment.id,
    attempts: result.attempts,
    error: result.error.slice(0, 500),
  });
  await raiseException(deps, {
    kind: "stop_failed",
    eventId: opts.eventId ?? null,
    leadId,
    escalate: true,
    detail: {
      stop: "instantly_delete_lead",
      reason,
      enrollment_id: enrollment.id,
      campaign_id: enrollment.campaign_id,
      provider_lead_id: enrollment.provider_lead_id,
      attempts: result.attempts,
      error: result.error.slice(0, 500),
    },
  });
  if (!opts.noPause) {
    const account = await loadSender(deps.db, enrollment.send_account_id);
    if (account) {
      await pauseSender(deps, {
        account,
        reason: `stop_failed: lead ${leadId} could not be removed from Instantly (${reason})`,
        eventId: opts.eventId ?? null,
        why: `stop_failed for lead ${leadId} (${reason}) after ${result.attempts} DELETE attempt(s)`,
        skipLeadId: leadId,
      });
    }
  }
  return { outcome: "stop_failed", ...frozen, attempts: result.attempts, enrollment_id: enrollment.id, error: result.error };
}

type DeleteResult =
  | { ok: true; attempts: number; providerLeadId: string | null }
  | { ok: false; attempts: number; error: string };

async function deleteAndConfirm(
  deps: StopDeps,
  enrollment: InstantlyEnrollmentRowShape,
  email: string | null,
): Promise<DeleteResult> {
  let providerLeadId = enrollment.provider_lead_id;
  if (!providerLeadId) {
    // Enrolled but the provider id was never recorded: find it by email.
    if (!email) return { ok: false, attempts: 0, error: "no provider lead id and no lead email" };
    try {
      const found = await deps.instantly.findLeadInCampaign(enrollment.campaign_id, email);
      if (!found) return { ok: true, attempts: 0, providerLeadId: null }; // leads/list 0: nothing to delete
      providerLeadId = found.id;
    } catch (error) {
      return { ok: false, attempts: 0, error: `lookup: ${message(error)}` };
    }
  }

  let lastError = "";
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      await deps.instantly.deleteLead(providerLeadId);
    } catch (error) {
      if (error instanceof InstantlyPermanentError && error.status === 404) {
        // Already gone; still confirmed below.
      } else if (error instanceof InstantlyUncertainOutcomeError) {
        // May have been applied: read before anything else, never assume.
        lastError = message(error);
      } else if (error instanceof InstantlyRetryableError) {
        // Not dispatched (connect phase) or refused (429): nothing applied.
        lastError = message(error);
        continue;
      } else {
        // Auth/scope/validation: another attempt will not change it.
        return { ok: false, attempts, error: message(error) };
      }
    }
    const check = await confirmGone(deps, providerLeadId, enrollment.campaign_id, email);
    if (check.gone) return { ok: true, attempts, providerLeadId };
    lastError = check.error ?? (lastError || "lead still present after DELETE");
  }
  return { ok: false, attempts, error: lastError };
}

/** Removed = GET /leads/{id} 404 AND leads/list for the campaign + email returns nothing (S18). */
async function confirmGone(
  deps: StopDeps,
  providerLeadId: string,
  campaignId: string,
  email: string | null,
): Promise<{ gone: boolean; error?: string }> {
  try {
    const lead = await deps.instantly.getLead(providerLeadId);
    if (lead) return { gone: false, error: `lead ${providerLeadId} still present (status ${lead.status})` };
    if (email) {
      const listed = await deps.instantly.findLeadInCampaign(campaignId, email);
      if (listed) return { gone: false, error: `leads/list still returns ${listed.id}` };
    }
    return { gone: true };
  } catch (error) {
    return { gone: false, error: `confirm: ${message(error)}` };
  }
}

// ---------------------------------------------------------------------------
// Sender pause: campaign first, then every in-flight lead
// ---------------------------------------------------------------------------

/**
 * Stops a sender: engine side first (health=paused, which preflight and
 * pickSender both refuse), then its Instantly campaign, then every live
 * enrollment of that sender is stopped and its queued/sent lead held. A
 * failed campaign pause or lead stop is escalated, never ignored. Shared by
 * the bounce auto-pause, the reconcile stale-stop check, the recipient check
 * and a failed stop.
 */
export async function pauseSender(
  deps: StopDeps,
  input: {
    account: SenderRef;
    /** Written to paused_reason; null when the caller already wrote health/paused_reason. */
    reason: string | null;
    eventId?: string | null;
    /** The alert's second line. */
    why: string;
    /** A lead the caller is already stopping (its own stop failed or is in hand). */
    skipLeadId?: string;
  },
): Promise<{ campaignPaused: boolean; leadsStopped: number; leadsStopFailed: number }> {
  const { account } = input;
  if (input.reason !== null) {
    const { error } = await deps.db
      .from("send_accounts")
      .update({ health: "paused", paused_reason: input.reason.slice(0, 500) })
      .eq("id", account.id);
    if (error) throw new WebhookProcessingError(`pause sender: ${error.message}`);
  }

  let campaignPaused = false;
  if (account.instantly_campaign_id) {
    try {
      await deps.instantly.pauseCampaign(account.instantly_campaign_id);
      campaignPaused = true;
    } catch (pauseError) {
      await raiseException(deps, {
        kind: "stop_failed",
        eventId: input.eventId ?? null,
        escalate: true,
        detail: {
          stop: "instantly_pause_campaign",
          send_account_id: account.id,
          error: message(pauseError),
        },
      });
    }
  }

  // Then every in-flight lead of this sender (operator, Session 17).
  const { data: live, error: liveError } = await enrollDb(deps.db)
    .from("instantly_enrollments")
    .select("lead_id")
    .eq("send_account_id", account.id)
    .in("state", [...LIVE_ENROLLMENT_STATES]);
  if (liveError) throw new StopError(`sender enrollments: ${liveError.message}`);
  const leadIds = [...new Set((live ?? []).map((r) => r.lead_id))].filter((id) => id !== input.skipLeadId);

  let stopped = 0;
  let failed = 0;
  for (const leadId of leadIds) {
    const outcome = await stopSequence(deps, leadId, "sender_paused", { noPause: true, eventId: input.eventId });
    if (outcome.outcome === "stop_failed") failed += 1;
    else stopped += 1;
    const state = await currentState(deps.db, leadId);
    if (state && HOLD_ON_SENDER_PAUSE.includes(state)) {
      await deps.transition(leadId, state, "manual_hold", "sender_paused", {
        send_account_id: account.id,
        stop: outcome.outcome,
      });
    }
  }

  await deps.alert(
    `⛔ Sender auto-paused: ${account.identifier ?? account.id}\n` +
      `${input.why}\n` +
      `Engine: health=paused. Instantly campaign pause: ${campaignPaused ? "done" : "NOT done — see exceptions"}.` +
      (leadIds.length ? `\nIn-flight leads: ${stopped} removed, ${failed} stop_failed.` : ""),
  );
  return { campaignPaused, leadsStopped: stopped, leadsStopFailed: failed };
}

// ---------------------------------------------------------------------------
// Manual hold
// ---------------------------------------------------------------------------

/** Operator hold: lead → manual_hold (via lib/state), then its sequence is stopped. */
export async function holdAndStop(
  deps: StopDeps,
  leadId: string,
  event: string,
  detail: Record<string, unknown> = {},
): Promise<{ held: boolean; from: LeadState | null; stop: StopOutcome }> {
  const from = await currentState(deps.db, leadId);
  let held = false;
  if (from && from !== "manual_hold" && from !== "suppressed") {
    await deps.transition(leadId, from, "manual_hold", event, detail);
    held = true;
  }
  const stop = await stopSequence(deps, leadId, "manual_hold");
  return { held, from, stop };
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/** Kills the lead's unsent follow-up touches (step >= 2) and cancels queued jobs on them. */
export async function killFollowups(db: AnyDb, leadId: string, now: Date): Promise<{ killed_touches: number; cancelled_jobs: number }> {
  const { data: touches, error } = await db
    .from("touches")
    .select("id, status")
    .eq("lead_id", leadId)
    .eq("direction", "outbound")
    .gte("step_no", 2);
  if (error) throw new StopError(`follow-up touches: ${error.message}`);
  const ids = (touches ?? []).filter((t) => KILLABLE_FOLLOWUP_STATUSES.includes(t.status ?? "")).map((t) => t.id);
  if (!ids.length) return { killed_touches: 0, cancelled_jobs: 0 };

  const { error: killError } = await db.from("touches").update({ status: "killed" }).in("id", ids);
  if (killError) throw new StopError(`kill follow-ups: ${killError.message}`);
  const { data: jobs, error: jobError } = await db
    .from("jobs")
    .update({ state: "cancelled", finished_at: now.toISOString(), last_error: "sequence stopped" })
    .eq("state", "queued")
    .in("payload->>touch_id", ids)
    .select("id");
  if (jobError) throw new StopError(`cancel follow-up jobs: ${jobError.message}`);
  return { killed_touches: ids.length, cancelled_jobs: (jobs ?? []).length };
}

async function liveEnrollment(db: AnyDb, leadId: string): Promise<InstantlyEnrollmentRowShape | null> {
  const { data, error } = await enrollDb(db)
    .from("instantly_enrollments")
    .select("*")
    .eq("lead_id", leadId)
    .in("state", [...LIVE_ENROLLMENT_STATES])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new StopError(`live enrollment: ${error.message}`);
  return data?.[0] ?? null;
}

async function hasRemovedEnrollment(db: AnyDb, leadId: string): Promise<boolean> {
  const { data, error } = await enrollDb(db)
    .from("instantly_enrollments")
    .select("id")
    .eq("lead_id", leadId)
    .eq("state", "removed")
    .limit(1);
  if (error) throw new StopError(`removed enrollment: ${error.message}`);
  return (data ?? []).length > 0;
}

async function leadEmail(db: AnyDb, leadId: string): Promise<string | null> {
  const { data, error } = await db.from("leads").select("email").eq("id", leadId).maybeSingle();
  if (error) throw new StopError(`lead email: ${error.message}`);
  return data?.email ?? null;
}

async function currentState(db: AnyDb, leadId: string): Promise<LeadState | null> {
  const { data, error } = await db.from("leads").select("state").eq("id", leadId).maybeSingle();
  if (error) throw new StopError(`lead state: ${error.message}`);
  return (data?.state as LeadState | undefined) ?? null;
}

export async function loadSender(db: AnyDb, sendAccountId: string): Promise<SenderRef | null> {
  const { data, error } = await db
    .from("send_accounts")
    .select("id, identifier, instantly_campaign_id")
    .eq("id", sendAccountId)
    .maybeSingle();
  if (error) throw new StopError(`load sender: ${error.message}`);
  return data ?? null;
}

async function logEvent(db: AnyDb, leadId: string, event: string, detail: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("lead_events").insert({ lead_id: leadId, event, detail: detail as Json });
  if (error) throw new StopError(`lead_event ${event}: ${error.message}`);
}
