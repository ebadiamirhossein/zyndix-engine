import type { SupabaseClient } from "@supabase/supabase-js";

import { type InstantlyClient, InstantlyRetryableError } from "@/lib/integrations/instantly";
import type { InstantlyEmail } from "@/lib/integrations/instantly-types";
import type { JobQueue } from "@/lib/jobs/queue";
import { killFollowups, stopSequence } from "@/lib/sending/stop";
import { checkSuppression, normalizeEmail } from "@/lib/sending/suppression";
import type { createStateStore } from "@/lib/state/core";
import {
  type InstantlyWebhookDeps,
  pauseSender,
  processInstantlyEvent,
  raiseException,
  type WebhookOutcome,
} from "@/lib/webhooks/instantly";
import type { Database, Json } from "@/types/database";
import type { DatabaseWithEnrollments, DatabaseWithWebhooks, InstantlyEnrollmentRowShape } from "@/types/database-extensions";
import type { LeadState } from "@/types/enums";

// Reconciliation (09 §U6): the safety net under the webhook stop path.
//
//   stop_processing_stale — a sender whose sends were accepted 25h+ ago but
//     which has received ZERO webhook events since is treated as having no
//     working stop path: the sender is paused (engine health + its Instantly
//     campaign), an escalated exception is raised, and the operator alerted.
//     Sending without a working reply/unsubscribe path is the one failure that
//     cannot be undone, so the check fails closed.
//
//   reply poll — GET /api/v2/emails (email_type=received) per sender, for the
//     leads still awaiting a reply. Each unseen reply is fed to the SAME
//     processor as a webhook delivery (processInstantlyEvent), so the freeze,
//     job cancellation, auto-reply handling and exceptions are identical.
//     Dedupe is by Instantly email id: an inbound touch with that
//     provider_message_id means the reply is already recorded. Polled rows in
//     webhook_events carry payload.source = "reconcile_poll" and never count
//     as webhook activity for the stale check.
//
//   instantly_leads sweep (09 §U6c S21) — the safety net under stopSequence:
//     R1: an enrollment that is still live while the engine considers the lead
//     stopped (a stopped lead state, a stop that never finished, or an email
//     on the suppression list) is read at Instantly; still there → stopped
//     again + escalated `stopped_lead_active`; gone → recorded removed.
//     R2: an Active lead in one of our sender campaigns that the engine never
//     enrolled → `unknown_active_lead`, report only (zero mutations).
//
// No cursor table: the poll window is derived from the awaiting leads' own
// send times (floored at 30 days), and dedupe makes re-reading harmless.
// GET /api/v2/emails is limited to 20 req/min; the adapter spaces calls and
// this job caps its own requests per run. A 429 or an exhausted budget ends
// the run as `truncated`; the next tick resumes. Two truncated runs in a row
// escalate to the operator.

export const STALE_STOP_JOB_TYPE = "reconcile.stale_stop";
export const INSTANTLY_LEADS_JOB_TYPE = "reconcile.instantly_leads";
export const REPLY_POLL_JOB_TYPE = "reconcile.reply_poll";
export const POLL_SOURCE = "reconcile_poll";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const STALE_AFTER_HOURS = 25;
const STALE_LOOKBACK_MS = 7 * DAY_MS;
const POLL_LOOKBACK_MS = 30 * DAY_MS;
export const POLL_PAGE_LIMIT = 100;
export const POLL_MAX_PAGES_PER_SENDER = 3;
export const POLL_MAX_REQUESTS_PER_RUN = 10;

/** A reply on a lead in one of these states has been fully applied (mirrors the processor). */
const FINISHED_STATES: readonly LeadState[] = [
  "replied",
  "classifying",
  "human_review",
  "meeting_booked",
  "handed_off",
  "suppressed",
  "manual_hold",
  "bounced",
];

/** Lead states in which a reply may still be missing from the engine. */
const AWAITING_REPLY_STATES: readonly LeadState[] = ["queued", "sent", "no_reply", "sequence_done"];

type ReconcileDb = SupabaseClient<DatabaseWithWebhooks>;

export type ReconcileDeps = {
  db: ReconcileDb;
  instantly: Pick<
    InstantlyClient,
    | "listEmails"
    | "pauseCampaign"
    | "addBlockListEntry"
    | "deleteLead"
    | "getLead"
    | "findLeadInCampaign"
    | "listCampaignLeads"
  >;
  queue: Pick<JobQueue, "enqueue">;
  transition: ReturnType<typeof createStateStore>["transition"];
  getActiveSetting: (key: string) => Promise<{ version: number; value: unknown }>;
  alert: (text: string) => Promise<void>;
  now?: () => Date;
};

export class ReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileError";
  }
}

type SenderRow = { id: string; identifier: string | null; instantly_campaign_id: string | null };

export type ReconcileOptions = {
  /** Only these senders (tests use fixture accounts); production passes nothing. */
  sendAccountIds?: string[];
};

function clock(deps: ReconcileDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

// ---------------------------------------------------------------------------
// stop_processing_stale
// ---------------------------------------------------------------------------

export type StaleSenderResult =
  | { send_account_id: string; verdict: "no_aged_sends" }
  | { send_account_id: string; verdict: "ok"; events: number }
  | { send_account_id: string; verdict: "paused"; sends: number; since: string; campaign_paused: boolean };

export async function runStaleStopCheck(
  deps: ReconcileDeps,
  options: ReconcileOptions = {},
): Promise<{ senders: StaleSenderResult[] }> {
  const now = clock(deps);
  let query = deps.db
    .from("send_accounts")
    .select("id, identifier, instantly_campaign_id")
    .eq("health", "ok")
    .not("instantly_campaign_id", "is", null);
  if (options.sendAccountIds) query = query.in("id", options.sendAccountIds);
  const { data: accounts, error } = await query;
  if (error) throw new ReconcileError(`load senders: ${error.message}`);

  const senders: StaleSenderResult[] = [];
  for (const account of accounts ?? []) {
    const { data: sends, error: sendError } = await deps.db
      .from("touches")
      .select("id, sent_at")
      .eq("send_account_id", account.id)
      .eq("direction", "outbound")
      .not("sent_at", "is", null)
      .lte("sent_at", new Date(now.getTime() - STALE_AFTER_HOURS * HOUR_MS).toISOString())
      .gte("sent_at", new Date(now.getTime() - STALE_LOOKBACK_MS).toISOString())
      .order("sent_at", { ascending: true });
    if (sendError) throw new ReconcileError(`aged sends: ${sendError.message}`);
    if (!sends?.length) {
      senders.push({ send_account_id: account.id, verdict: "no_aged_sends" });
      continue;
    }

    const since = sends[0]!.sent_at as string;
    const events = await providerEventsSince(deps.db, account, since);
    if (events > 0) {
      senders.push({ send_account_id: account.id, verdict: "ok", events });
      continue;
    }

    const why =
      `stop_processing_stale: ${sends.length} send(s) accepted ≥${STALE_AFTER_HOURS}h ago, ` +
      `0 webhook events since ${since}. Reply/unsubscribe processing is not proven to work.`;
    // Stop first, then record: the pause must not depend on the bookkeeping.
    const { campaignPaused } = await pauseSender(deps, { account, reason: why, why });
    await raiseException(deps, {
      kind: "stop_processing_stale",
      eventId: null,
      escalate: true,
      notify: false, // pauseSender already alerted with the same facts
      detail: {
        send_account_id: account.id,
        identifier: account.identifier,
        campaign_id: account.instantly_campaign_id,
        sends: sends.length,
        oldest_sent_at: since,
        threshold_hours: STALE_AFTER_HOURS,
        campaign_paused: campaignPaused,
      },
    });
    senders.push({ send_account_id: account.id, verdict: "paused", sends: sends.length, since, campaign_paused: campaignPaused });
  }
  return { senders };
}

/** Webhook deliveries attributable to this sender since `since`; polled rows excluded. */
async function providerEventsSince(db: ReconcileDb, account: SenderRow, since: string): Promise<number> {
  const ids = new Set<string>();
  const collect = async (column: "payload->>campaign_id" | "payload->>email_account", value: string, exact: boolean) => {
    const base = db.from("webhook_events").select("id, payload").eq("provider", "instantly").gte("created_at", since);
    const filtered = exact ? base.eq(column, value) : base.ilike(column, value.replace(/[\\%_]/g, (c) => `\\${c}`));
    const { data, error } = await filtered.limit(200);
    if (error) throw new ReconcileError(`webhook activity: ${error.message}`);
    for (const row of data ?? []) {
      const payload = row.payload as Record<string, unknown> | null;
      if (payload?.source !== POLL_SOURCE) ids.add(row.id);
    }
  };
  if (account.instantly_campaign_id) await collect("payload->>campaign_id", account.instantly_campaign_id, true);
  if (account.identifier) await collect("payload->>email_account", normalizeEmail(account.identifier), false);
  return ids.size;
}

// ---------------------------------------------------------------------------
// Missed-reply poll
// ---------------------------------------------------------------------------

export type ReplyPollSummary = {
  requests: number;
  truncated: boolean;
  truncated_reason: "request_budget" | "page_cap" | "rate_limited" | null;
  senders_polled: number;
  seen: number;
  ignored_unmatched: number;
  already_seen: number;
  outcomes: Record<string, number>;
};

type AwaitingLead = { id: string; email: string | null; state: string; state_changed_at: string | null };

export async function runReplyPoll(deps: ReconcileDeps, options: ReconcileOptions = {}): Promise<ReplyPollSummary> {
  const now = clock(deps);
  const summary: ReplyPollSummary = {
    requests: 0,
    truncated: false,
    truncated_reason: null,
    senders_polled: 0,
    seen: 0,
    ignored_unmatched: 0,
    already_seen: 0,
    outcomes: {},
  };
  const webhookDeps: InstantlyWebhookDeps = {
    db: deps.db,
    secret: undefined, // not an HTTP delivery: no token to check
    transition: deps.transition,
    instantly: deps.instantly,
    queue: deps.queue,
    getActiveSetting: deps.getActiveSetting,
    alert: deps.alert,
    now: deps.now,
  };

  // Paused senders are polled too: a paused sender's replies still matter.
  let query = deps.db.from("send_accounts").select("id, identifier, instantly_campaign_id").not("identifier", "is", null);
  if (options.sendAccountIds) query = query.in("id", options.sendAccountIds);
  const { data: accounts, error } = await query;
  if (error) throw new ReconcileError(`load senders: ${error.message}`);

  senders: for (const account of accounts ?? []) {
    const window = await pollWindow(deps.db, account.id, now);
    if (!window) continue;
    summary.senders_polled += 1;

    let startingAfter: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page >= POLL_MAX_PAGES_PER_SENDER) {
        summary.truncated = true;
        summary.truncated_reason ??= "page_cap";
        break;
      }
      if (summary.requests >= POLL_MAX_REQUESTS_PER_RUN) {
        summary.truncated = true;
        summary.truncated_reason ??= "request_budget";
        break senders;
      }
      summary.requests += 1;
      let result;
      try {
        result = await deps.instantly.listEmails({
          eaccount: account.identifier!,
          emailType: "received",
          minTimestampCreated: window.start,
          sortOrder: "asc",
          limit: POLL_PAGE_LIMIT,
          startingAfter,
        });
      } catch (listError) {
        // 429 / 5xx / network after the adapter's own single retry: stop the
        // run, keep everything processed so far, resume next tick.
        if (listError instanceof InstantlyRetryableError) {
          summary.truncated = true;
          summary.truncated_reason = "rate_limited";
          break senders;
        }
        throw listError;
      }

      for (const email of result.items) {
        summary.seen += 1;
        if (email.ue_type !== undefined && email.ue_type !== null && email.ue_type !== 2) continue;
        const lead = window.leadsByEmail.get(normalizeEmail(email.lead ?? email.from_address_email ?? ""));
        if (!lead) {
          // Legacy campaigns, warmup, strangers: the webhook path owns their exceptions.
          summary.ignored_unmatched += 1;
          continue;
        }
        // Already recorded AND the freeze finished → nothing to do. A recorded
        // reply on a lead that is not frozen yet (an earlier attempt failed
        // half-way) goes through the processor again, which replays safely.
        if (FINISHED_STATES.includes(lead.state as LeadState) && (await hasInboundTouch(deps.db, lead.id, email.id))) {
          summary.already_seen += 1;
          continue;
        }
        const outcome = await processInstantlyEvent(webhookDeps, polledReplyPayload(email, account, lead));
        const key = outcomeKey(outcome);
        summary.outcomes[key] = (summary.outcomes[key] ?? 0) + 1;
      }

      const next = result.next_starting_after ?? null;
      if (!next || result.items.length < POLL_PAGE_LIMIT) break;
      startingAfter = next;
    }
  }

  await trackTruncation(deps, summary, now);
  return summary;
}

/**
 * The window for one sender: from the earliest send to a lead that may still
 * have an unrecorded reply, floored at 30 days. Null when no lead awaits one,
 * which means no request at all.
 */
async function pollWindow(
  db: ReconcileDb,
  sendAccountId: string,
  now: Date,
): Promise<{ start: string; leadsByEmail: Map<string, AwaitingLead> } | null> {
  const { data: leads, error } = await db
    .from("leads")
    .select("id, email, state, state_changed_at")
    .eq("send_account_id", sendAccountId);
  if (error) throw new ReconcileError(`bound leads: ${error.message}`);
  const all = (leads ?? []) as AwaitingLead[];
  const awaiting = all.filter((l) => AWAITING_REPLY_STATES.includes(l.state as LeadState));
  if (!awaiting.length) return null;

  const { data: sends, error: sendError } = await db
    .from("touches")
    .select("lead_id, sent_at")
    .in("lead_id", awaiting.map((l) => l.id))
    .eq("direction", "outbound")
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: true });
  if (sendError) throw new ReconcileError(`window sends: ${sendError.message}`);

  const times: number[] = (sends ?? []).map((s) => Date.parse(s.sent_at as string));
  // A queued lead may be accepted by the provider before any touch carries sent_at.
  const withSend = new Set((sends ?? []).map((s) => s.lead_id));
  for (const lead of awaiting) {
    if (!withSend.has(lead.id) && lead.state_changed_at) times.push(Date.parse(lead.state_changed_at));
  }
  const finite = times.filter(Number.isFinite);
  if (!finite.length) return null;
  const start = Math.max(Math.min(...finite), now.getTime() - POLL_LOOKBACK_MS);

  // Replies are matched against every lead bound to this sender (a second
  // reply from an already-replied lead is a real message), not just awaiting ones.
  const leadsByEmail = new Map<string, AwaitingLead>();
  for (const lead of all) {
    const email = normalizeEmail(lead.email ?? "");
    if (email) leadsByEmail.set(email, lead);
  }
  return { start: new Date(start).toISOString(), leadsByEmail };
}

async function hasInboundTouch(db: ReconcileDb, leadId: string, emailId: string): Promise<boolean> {
  const { data, error } = await db
    .from("touches")
    .select("id")
    .eq("lead_id", leadId)
    .eq("direction", "inbound")
    .eq("provider_message_id", emailId)
    .limit(1);
  if (error) throw new ReconcileError(`inbound lookup: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * A received email in the webhook's reply_received shape. Deterministic (no
 * clock), so re-polling the same email hashes to the same webhook_events row.
 */
export function polledReplyPayload(email: InstantlyEmail, account: SenderRow, lead: AwaitingLead): Record<string, unknown> {
  return {
    event_type: "reply_received",
    source: POLL_SOURCE,
    campaign_id: email.campaign_id ?? account.instantly_campaign_id ?? null,
    email_account: email.eaccount,
    lead_email: normalizeEmail(email.lead ?? email.from_address_email ?? lead.email ?? ""),
    email_id: email.id,
    reply_subject: email.subject,
    reply_text: email.body?.text ?? email.content_preview ?? null,
    timestamp: email.timestamp_email ?? email.timestamp_created,
    is_auto_reply: email.is_auto_reply ?? null,
    thread_id: email.thread_id ?? null,
  };
}

function outcomeKey(outcome: WebhookOutcome): string {
  if (outcome.kind === "processed") return outcome.action;
  if (outcome.kind === "exception") return `exception:${outcome.exception}`;
  return "duplicate";
}

/**
 * One open `reply_poll_truncated` exception per streak. The first truncated
 * run opens it quietly; a second consecutive one escalates it (one alert). A
 * complete run resolves it.
 */
async function trackTruncation(deps: ReconcileDeps, summary: ReplyPollSummary, now: Date): Promise<void> {
  const { data: open, error } = await deps.db
    .from("exceptions")
    .select("id, status")
    .eq("kind", "reply_poll_truncated")
    .neq("status", "resolved")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new ReconcileError(`truncation lookup: ${error.message}`);
  const current = open?.[0] ?? null;

  if (!summary.truncated) {
    if (current) {
      const { error: resolveError } = await deps.db
        .from("exceptions")
        .update({ status: "resolved", resolved_at: now.toISOString(), resolved_by: "reconcile.reply_poll" })
        .eq("id", current.id);
      if (resolveError) throw new ReconcileError(`truncation resolve: ${resolveError.message}`);
    }
    return;
  }

  const detail = { reason: summary.truncated_reason, requests: summary.requests, seen: summary.seen };
  if (!current) {
    await raiseException(deps, { kind: "reply_poll_truncated", eventId: null, detail });
    return;
  }
  if (current.status === "open") {
    const { error: escalateError } = await deps.db
      .from("exceptions")
      .update({ status: "escalated", escalated_at: now.toISOString() })
      .eq("id", current.id)
      .eq("status", "open");
    if (escalateError) throw new ReconcileError(`truncation escalate: ${escalateError.message}`);
    await deps.alert(
      `⚠️ Reply poll truncated twice in a row (${summary.truncated_reason}).\n` +
        `Missed replies may not be recovered until it completes. Check exceptions.`,
    );
  }
}

// ---------------------------------------------------------------------------
// instantly_leads sweep (09 §U6c S21)
// ---------------------------------------------------------------------------

/** Lead states in which no Instantly step may go out any more. */
const STOPPED_LEAD_STATES: readonly LeadState[] = [
  "replied",
  "classifying",
  "human_review",
  "meeting_booked",
  "handed_off",
  "suppressed",
  "manual_hold",
  "bounced",
  "parked",
];
/** Instantly Lead.status (OpenAPI enum, read 2026-09-26): 1 Active, 2 Paused, 3 Completed, -1 Bounced, -2 Unsubscribed, -3 Skipped. */
export const INSTANTLY_LEAD_ACTIVE = 1;
export const SWEEP_PAGE_LIMIT = 100;
export const SWEEP_MAX_PAGES_PER_CAMPAIGN = 5;

export type LeadSweepSummary = {
  enrollments_checked: number;
  stopped_lead_active: number;
  suppressed_found: number;
  confirmed_removed: number;
  unreadable: number;
  campaigns_scanned: number;
  active_leads_seen: number;
  unknown_active_lead: number;
  truncated: boolean;
};

export async function runInstantlyLeadSweep(deps: ReconcileDeps, options: ReconcileOptions = {}): Promise<LeadSweepSummary> {
  const summary: LeadSweepSummary = {
    enrollments_checked: 0,
    stopped_lead_active: 0,
    suppressed_found: 0,
    confirmed_removed: 0,
    unreadable: 0,
    campaigns_scanned: 0,
    active_leads_seen: 0,
    unknown_active_lead: 0,
    truncated: false,
  };
  await sweepStoppedEnrollments(deps, options, summary);
  await sweepUnknownActiveLeads(deps, options, summary);
  return summary;
}

function enrollDb(db: ReconcileDb): SupabaseClient<DatabaseWithEnrollments> {
  return db as unknown as SupabaseClient<DatabaseWithEnrollments>;
}

/** R1: live enrollments of leads the engine has stopped. */
async function sweepStoppedEnrollments(deps: ReconcileDeps, options: ReconcileOptions, summary: LeadSweepSummary): Promise<void> {
  const now = clock(deps);
  let query = enrollDb(deps.db).from("instantly_enrollments").select("*").in("state", ["active", "stopping", "stop_failed"]);
  if (options.sendAccountIds) query = query.in("send_account_id", options.sendAccountIds);
  const { data: enrollments, error } = await query;
  if (error) throw new ReconcileError(`live enrollments: ${error.message}`);

  for (const enrollment of enrollments ?? []) {
    const { data: lead, error: leadError } = await deps.db.from("leads").select("id, state, email").eq("id", enrollment.lead_id).maybeSingle();
    if (leadError) throw new ReconcileError(`sweep lead: ${leadError.message}`);
    if (!lead) continue;
    summary.enrollments_checked += 1;
    const state = lead.state as LeadState;

    const hit = await checkSuppression(deps.db as unknown as SupabaseClient<Database>, { email: lead.email, companyDomain: null });
    const suppressed = hit.email || hit.domain;
    const stopped = STOPPED_LEAD_STATES.includes(state) || enrollment.state !== "active" || suppressed;
    if (!stopped) continue;

    if (suppressed && state !== "suppressed") {
      // A suppression written outside the webhook path (operator, dashboard):
      // the engine side catches up first, then the sequence is stopped.
      await deps.transition(lead.id, state, "suppressed", "suppression_found_by_sweep", { suppression_ids: hit.rowIds });
      summary.suppressed_found += 1;
      await stopSequence(deps, lead.id, "suppressed");
      continue;
    }

    const presence = await instantlyPresence(deps, enrollment, lead.email);
    if (presence === "unreadable") {
      summary.unreadable += 1; // next run retries; nothing assumed
      continue;
    }
    if (presence === "absent") {
      // Gone at Instantly already: record it, no DELETE.
      const killed = await killFollowups(deps.db, lead.id, now);
      const { error: updateError } = await enrollDb(deps.db)
        .from("instantly_enrollments")
        .update({
          state: "removed",
          removed_at: now.toISOString(),
          last_checked_at: now.toISOString(),
          stop_reason: enrollment.stop_reason ?? "stopped_lead_active",
        })
        .eq("id", enrollment.id);
      if (updateError) throw new ReconcileError(`sweep removed: ${updateError.message}`);
      await logLeadEvent(deps.db, lead.id, "enrollment_confirmed_removed", { enrollment_id: enrollment.id, lead_state: state, ...killed });
      summary.confirmed_removed += 1;
      continue;
    }

    await flagStoppedLeadActive(deps, enrollment, state, "engine_stopped");
    summary.stopped_lead_active += 1;
  }
}

/** Instantly still holds this lead → stop it again and escalate. */
async function flagStoppedLeadActive(
  deps: ReconcileDeps,
  enrollment: InstantlyEnrollmentRowShape,
  leadState: string,
  why: "engine_stopped" | "removed_but_active",
): Promise<void> {
  const outcome = await stopSequence(deps, enrollment.lead_id, "stopped_lead_active");
  await raiseException(deps, {
    kind: "stopped_lead_active",
    eventId: null,
    leadId: enrollment.lead_id,
    escalate: true,
    detail: {
      why,
      lead_state: leadState,
      enrollment_id: enrollment.id,
      enrollment_state: enrollment.state,
      campaign_id: enrollment.campaign_id,
      provider_lead_id: enrollment.provider_lead_id,
      stop: outcome.outcome,
    },
  });
}

async function instantlyPresence(
  deps: ReconcileDeps,
  enrollment: InstantlyEnrollmentRowShape,
  email: string | null,
): Promise<"present" | "absent" | "unreadable"> {
  try {
    if (enrollment.provider_lead_id) {
      return (await deps.instantly.getLead(enrollment.provider_lead_id)) ? "present" : "absent";
    }
    if (!email) return "unreadable";
    return (await deps.instantly.findLeadInCampaign(enrollment.campaign_id, email)) ? "present" : "absent";
  } catch {
    return "unreadable";
  }
}

/** R2: Active leads in our sender campaigns that the engine never enrolled (report only). */
async function sweepUnknownActiveLeads(deps: ReconcileDeps, options: ReconcileOptions, summary: LeadSweepSummary): Promise<void> {
  let query = deps.db.from("send_accounts").select("id, identifier, instantly_campaign_id").not("instantly_campaign_id", "is", null);
  if (options.sendAccountIds) query = query.in("id", options.sendAccountIds);
  const { data: accounts, error } = await query;
  if (error) throw new ReconcileError(`sweep senders: ${error.message}`);

  for (const account of accounts ?? []) {
    const campaignId = account.instantly_campaign_id!;
    summary.campaigns_scanned += 1;
    let startingAfter: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page >= SWEEP_MAX_PAGES_PER_CAMPAIGN) {
        summary.truncated = true;
        break;
      }
      let result;
      try {
        result = await deps.instantly.listCampaignLeads(campaignId, { limit: SWEEP_PAGE_LIMIT, startingAfter });
      } catch {
        summary.truncated = true;
        break;
      }
      const active = result.items.filter((l) => l.status === INSTANTLY_LEAD_ACTIVE && (!l.campaign || l.campaign === campaignId));
      summary.active_leads_seen += active.length;
      if (active.length) {
        const { data: known, error: knownError } = await enrollDb(deps.db)
          .from("instantly_enrollments")
          .select("*")
          .in("provider_lead_id", active.map((l) => l.id));
        if (knownError) throw new ReconcileError(`sweep known leads: ${knownError.message}`);
        const byProviderId = new Map((known ?? []).map((e) => [e.provider_lead_id!, e]));
        for (const lead of active) {
          const enrollment = byProviderId.get(lead.id);
          if (!enrollment) {
            if (await reportUnknownActiveLead(deps, account, lead)) summary.unknown_active_lead += 1;
            continue;
          }
          if (enrollment.state === "removed") {
            // The engine recorded it removed, but Instantly still runs it: reopen and stop again.
            const { error: reopenError } = await enrollDb(deps.db)
              .from("instantly_enrollments")
              .update({ state: "stopping" })
              .eq("id", enrollment.id)
              .eq("state", "removed");
            if (reopenError) throw new ReconcileError(`sweep reopen: ${reopenError.message}`);
            const { data: lead2 } = await deps.db.from("leads").select("state").eq("id", enrollment.lead_id).maybeSingle();
            await flagStoppedLeadActive(deps, enrollment, lead2?.state ?? "unknown", "removed_but_active");
            summary.stopped_lead_active += 1;
          }
        }
      }
      const last = result.items.at(-1)?.id;
      if (!last || result.items.length < SWEEP_PAGE_LIMIT) break;
      startingAfter = last;
    }
  }
}

/** One open exception per unknown provider lead: a repeat sweep does not re-raise it. */
async function reportUnknownActiveLead(
  deps: ReconcileDeps,
  account: SenderRow,
  lead: { id: string; email?: string | null; status: number },
): Promise<boolean> {
  const { data: open, error } = await deps.db
    .from("exceptions")
    .select("id")
    .eq("kind", "unknown_active_lead")
    .neq("status", "resolved")
    .eq("detail->>provider_lead_id", lead.id)
    .limit(1);
  if (error) throw new ReconcileError(`unknown lead lookup: ${error.message}`);
  if ((open ?? []).length > 0) return false;
  await raiseException(deps, {
    kind: "unknown_active_lead",
    eventId: null,
    detail: {
      provider_lead_id: lead.id,
      lead_email: lead.email ?? null,
      status: lead.status,
      campaign_id: account.instantly_campaign_id,
      send_account_id: account.id,
      identifier: account.identifier,
    },
  });
  return true;
}

async function logLeadEvent(db: ReconcileDb, leadId: string, event: string, detail: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("lead_events").insert({ lead_id: leadId, event, detail: detail as Json });
  if (error) throw new ReconcileError(`lead_event ${event}: ${error.message}`);
}
