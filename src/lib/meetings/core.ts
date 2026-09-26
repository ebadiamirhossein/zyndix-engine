import type { SupabaseClient } from "@supabase/supabase-js";

import { CLASSIFY_REPLY_JOB_TYPE, SAFETY_JOB_TYPES } from "@/lib/jobs/types";
import { normalizeEmail } from "@/lib/sending/suppression";
import { type StopDeps, stopSequence } from "@/lib/sending/stop";
import type { createStateStore } from "@/lib/state/core";
import type { CalendlyInvitee } from "@/lib/validation/external";
import { type ExceptionKind, raiseException, WebhookProcessingError } from "@/lib/webhooks/exceptions";
import type { Json } from "@/types/database";
import type { DatabaseWithWave1, DatabaseWithWebhooks, MeetingRowShape } from "@/types/database-extensions";
import { canTransition, type LeadState, type MeetingStatus } from "@/types/enums";

// Meetings (09 §U8, brief §9 Calendly row, §10, §11). One `meetings` row per
// Calendly invitee (external_id = the invitee `uri`); a reschedule is a new
// invitee linked to the old one (rescheduled_from / rescheduled_to).
//
// The booking stop: a meeting stops outreach for that person on every channel
// — queued jobs cancelled, unsent outbound touches killed, the lead →
// meeting_booked through lib/state, the Instantly sequence removed
// (stopSequence), a meeting-prep task (lead_event `meeting_prep_due`) and a
// Telegram alert. Cancellation and rescheduling never restart cold contact:
// nothing in this module creates a job or moves a lead back to a sending state.

export type MeetingsDb = SupabaseClient<DatabaseWithWave1>;
export type MeetingRow = MeetingRowShape;

export const MEETINGS_PROVIDER = "calendly";

export type BookingDeps = {
  db: MeetingsDb;
  transition: ReturnType<typeof createStateStore>["transition"];
  instantly: StopDeps["instantly"];
  alert: (text: string) => Promise<void>;
  now?: () => Date;
};

export type LeadRef = { id: string; state: LeadState; email: string | null; company_id: string | null };

function webhookDb(db: MeetingsDb): SupabaseClient<DatabaseWithWebhooks> {
  return db as unknown as SupabaseClient<DatabaseWithWebhooks>;
}

function clock(deps: { now?: () => Date }): Date {
  return (deps.now ?? (() => new Date()))();
}

function fail(what: string, error: { message: string } | null): never {
  throw new WebhookProcessingError(`${what}: ${error?.message ?? "no row"}`);
}

// ---------------------------------------------------------------------------
// Lead matching
// ---------------------------------------------------------------------------

/** States in which the person has already been contacted (or booked). */
const CONTACTED_STATES: readonly LeadState[] = [
  "sent",
  "replied",
  "classifying",
  "human_review",
  "no_reply",
  "sequence_done",
  "meeting_booked",
  "handed_off",
];
/** Outreach approved or in flight, but not yet out. */
const IN_FLIGHT_STATES: readonly LeadState[] = ["pending_approval", "approved", "queued", "manual_hold"];

function stateRank(state: LeadState): number {
  if (state === "suppressed") return 3;
  if (CONTACTED_STATES.includes(state)) return 0;
  if (IN_FLIGHT_STATES.includes(state)) return 1;
  return 2;
}

type LeadCandidate = LeadRef & { updated_at: string | null };

/**
 * Deterministic choice among leads sharing the invitee's email: contacted
 * states first, then approved/in-flight, then anything else, suppressed last;
 * within a rank the most recently updated lead; ties by id. Exported for the
 * pure tests.
 */
export function rankCandidates<T extends { id: string; state: LeadState; updated_at: string | null }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    const r = stateRank(a.state) - stateRank(b.state);
    if (r !== 0) return r;
    const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
    const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Every lead whose normalized email equals `email`, ranked (primary first). */
export async function matchLeadsByEmail(db: MeetingsDb, email: string): Promise<LeadRef[]> {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  const { data, error } = await webhookDb(db)
    .from("leads")
    .select("id, state, email, company_id, updated_at")
    .ilike("email", normalized.replace(/[\\%_]/g, (c) => `\\${c}`));
  if (error) fail("match lead", error);
  const candidates: LeadCandidate[] = (data ?? [])
    .filter((l) => normalizeEmail(l.email) === normalized)
    .map((l) => ({ ...l, state: l.state as LeadState }));
  return rankCandidates(candidates).map(({ id, state, email: e, company_id }) => ({ id, state, email: e, company_id }));
}

export async function loadLead(db: MeetingsDb, leadId: string): Promise<LeadRef | null> {
  const { data, error } = await webhookDb(db).from("leads").select("id, state, email, company_id").eq("id", leadId).maybeSingle();
  if (error) fail("load lead", error);
  return data ? { ...data, state: data.state as LeadState } : null;
}

async function currentState(db: MeetingsDb, leadId: string): Promise<LeadState | null> {
  const { data, error } = await webhookDb(db).from("leads").select("state").eq("id", leadId).maybeSingle();
  if (error) fail("lead state", error);
  return (data?.state as LeadState | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Meeting rows
// ---------------------------------------------------------------------------

export async function findMeeting(db: MeetingsDb, externalId: string): Promise<MeetingRow | null> {
  const { data, error } = await db
    .from("meetings")
    .select("*")
    .eq("provider", MEETINGS_PROVIDER)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) fail("find meeting", error);
  return data ?? null;
}

export async function getMeeting(db: MeetingsDb, id: string): Promise<MeetingRow | null> {
  const { data, error } = await db.from("meetings").select("*").eq("id", id).maybeSingle();
  if (error) fail("get meeting", error);
  return data ?? null;
}

/** The invitee's facts as meeting columns (provider facts only). */
export function meetingFieldsFromInvitee(inv: CalendlyInvitee) {
  return {
    provider: MEETINGS_PROVIDER,
    external_id: inv.uri,
    scheduled_event_uri: inv.scheduled_event.uri,
    invitee_email: normalizeEmail(inv.email),
    invitee_name: inv.name ?? null,
    event_name: inv.scheduled_event.name ?? null,
    start_at: new Date(inv.scheduled_event.start_time).toISOString(),
    end_at: new Date(inv.scheduled_event.end_time).toISOString(),
  };
}

export function cancellationFields(inv: CalendlyInvitee, fallbackAt: string) {
  const c = inv.cancellation ?? null;
  return {
    canceled_at: c?.created_at ? new Date(c.created_at).toISOString() : new Date(fallbackAt).toISOString(),
    canceled_by: c?.canceled_by ?? null,
    canceler_type: c?.canceler_type ?? null,
    cancel_reason: c?.reason ?? null,
  };
}

export type EnsuredMeeting = { row: MeetingRow; created: boolean };

/**
 * Insert the row for this invitee, or load it when it already exists (an
 * earlier event of the same invitee, a replay, or a concurrent delivery that
 * won the unique index). `webhook_event_id` is the event that created the row
 * and is never overwritten, so a replay can recognise its own row.
 */
export async function ensureMeeting(
  db: MeetingsDb,
  insert: Partial<MeetingRow> & Pick<MeetingRow, "external_id" | "invitee_email">,
): Promise<EnsuredMeeting> {
  const existing = await findMeeting(db, insert.external_id);
  if (existing) return { row: existing, created: false };
  const { data, error } = await db
    .from("meetings")
    .insert({ provider: MEETINGS_PROVIDER, ...insert })
    .select("*")
    .single();
  if (!error && data) return { row: data, created: true };
  if (error?.code !== "23505") fail("insert meeting", error);
  const raced = await findMeeting(db, insert.external_id);
  if (!raced) fail("reload meeting after conflict", null);
  return { row: raced, created: false };
}

export async function updateMeeting(db: MeetingsDb, row: MeetingRow, patch: Partial<MeetingRow>): Promise<MeetingRow> {
  const changed = Object.fromEntries(
    Object.entries(patch).filter(([k, v]) => (row as Record<string, unknown>)[k] !== v),
  ) as Partial<MeetingRow>;
  if (!Object.keys(changed).length) return row;
  const { data, error } = await db.from("meetings").update(changed).eq("id", row.id).select("*").single();
  if (error || !data) fail("update meeting", error);
  return data;
}

// ---------------------------------------------------------------------------
// Lead events and exceptions, each at most once
// ---------------------------------------------------------------------------

/** Inserts `event` for (lead, meeting) unless it exists. True when inserted. */
export async function logMeetingEventOnce(
  db: MeetingsDb,
  leadId: string,
  event: string,
  meetingId: string,
  detail: Record<string, unknown>,
): Promise<boolean> {
  const wdb = webhookDb(db);
  const { data, error } = await wdb
    .from("lead_events")
    .select("id")
    .eq("lead_id", leadId)
    .eq("event", event)
    .eq("detail->>meeting_id", meetingId)
    .limit(1);
  if (error) fail(`lead_event ${event} lookup`, error);
  if ((data ?? []).length) return false;
  const { error: insertError } = await wdb
    .from("lead_events")
    .insert({ lead_id: leadId, event, detail: { ...detail, meeting_id: meetingId } as Json });
  if (insertError) fail(`lead_event ${event}`, insertError);
  return true;
}

/** raiseException, at most once per (kind, webhook event, lead) so a replay does not duplicate it. */
export async function raiseOnce(
  deps: Pick<BookingDeps, "db" | "alert" | "now">,
  input: { kind: ExceptionKind; eventId: string; leadId?: string; detail: Record<string, unknown>; escalate?: boolean },
): Promise<void> {
  const wdb = webhookDb(deps.db);
  let query = wdb.from("exceptions").select("id").eq("kind", input.kind).eq("webhook_event_id", input.eventId);
  query = input.leadId ? query.eq("lead_id", input.leadId) : query.is("lead_id", null);
  const { data, error } = await query.limit(1);
  if (error) fail("exception lookup", error);
  if ((data ?? []).length) return;
  await raiseException({ db: wdb, alert: deps.alert, now: deps.now }, { ...input, provider: "calendly" });
}

// ---------------------------------------------------------------------------
// The booking stop
// ---------------------------------------------------------------------------

/**
 * Jobs a booking never cancels: the post-send recipient check (an email that
 * already left must still be checked), the other safety jobs (they only
 * observe or stop outreach, 06 §5), and the reply classifier (inbound
 * handling, not outreach; U7 runs it after any freeze).
 */
export const BOOKING_EXEMPT_JOB_TYPES: readonly string[] = [...SAFETY_JOB_TYPES, CLASSIFY_REPLY_JOB_TYPE];
const KILLABLE_TOUCH_STATUSES = ["drafted", "pending_approval", "approved", "edited"];

/**
 * Cancels every queued job for the lead (by payload lead_id or any of its
 * touches) except BOOKING_EXEMPT_JOB_TYPES, and kills outbound touches that
 * have not left. Idempotent. Creates nothing.
 */
export async function freezeForMeeting(db: MeetingsDb, leadId: string, now: Date): Promise<{ cancelled_jobs: number; killed_touches: number }> {
  const wdb = webhookDb(db);
  const { data: touches, error } = await wdb.from("touches").select("id, status, direction").eq("lead_id", leadId);
  if (error) fail("booking freeze touches", error);
  const touchIds = (touches ?? []).map((t) => t.id);
  const exempt = `(${BOOKING_EXEMPT_JOB_TYPES.join(",")})`;
  const patch = { state: "cancelled" as const, finished_at: now.toISOString(), last_error: "meeting booked" };

  let cancelled = 0;
  if (touchIds.length) {
    const { data, error: jobError } = await wdb
      .from("jobs")
      .update(patch)
      .eq("state", "queued")
      .not("type", "in", exempt)
      .in("payload->>touch_id", touchIds)
      .select("id");
    if (jobError) fail("cancel touch jobs", jobError);
    cancelled += (data ?? []).length;
  }
  const { data: leadJobs, error: leadJobError } = await wdb
    .from("jobs")
    .update(patch)
    .eq("state", "queued")
    .not("type", "in", exempt)
    .eq("payload->>lead_id", leadId)
    .select("id");
  if (leadJobError) fail("cancel lead jobs", leadJobError);
  cancelled += (leadJobs ?? []).length;

  const killable = (touches ?? [])
    .filter((t) => t.direction !== "inbound" && KILLABLE_TOUCH_STATUSES.includes(t.status ?? ""))
    .map((t) => t.id);
  if (killable.length) {
    const { error: killError } = await wdb.from("touches").update({ status: "killed" }).in("id", killable);
    if (killError) fail("kill touches", killError);
  }
  return { cancelled_jobs: cancelled, killed_touches: killable.length };
}

export type BookingAction = "meeting_booked" | "already_booked" | "recorded_suppressed" | "booking_unexpected_state";

/** Pure: what a booking does to a lead in `state`. */
export function bookingActionFor(state: LeadState): BookingAction {
  if (state === "meeting_booked" || state === "handed_off") return "already_booked";
  if (state === "suppressed") return "recorded_suppressed";
  if (canTransition(state, "meeting_booked")) return "meeting_booked";
  return "booking_unexpected_state";
}

function fmt(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "time unknown";
}

/**
 * Stops outreach to a lead because it has a meeting. Every step is
 * idempotent, so a webhook replay repeats it safely:
 *   1. freeze (queued jobs cancelled, unsent outbound touches killed);
 *   2. lead → meeting_booked where the edge exists; already booked/handed off
 *      or suppressed → recorded only; any other state → manual_hold plus an
 *      escalated `booking_unexpected_state` (never a sending state);
 *   3. stopSequence(…, "meeting_booked") — Instantly is the only channel today;
 *   4. with `prep`, the meeting-prep task (lead_event `meeting_prep_due`)
 *      and a Telegram alert, once per meeting.
 */
export async function applyBookingStop(
  deps: BookingDeps,
  input: { eventId: string; lead: LeadRef; meeting: MeetingRow; prep: boolean; duplicateOf?: string },
): Promise<{ action: BookingAction; cancelled_jobs: number; killed_touches: number; stop: string }> {
  const now = clock(deps);
  const { lead, meeting, eventId } = input;
  const frozen = await freezeForMeeting(deps.db, lead.id, now);
  const state = (await currentState(deps.db, lead.id)) ?? lead.state;
  const action = bookingActionFor(state);
  const detail = {
    webhook_event_id: eventId,
    meeting_id: meeting.id,
    meeting_external_id: meeting.external_id,
    ...(input.duplicateOf ? { duplicate_of_lead: input.duplicateOf } : {}),
    ...frozen,
  };

  if (action === "meeting_booked") {
    await deps.transition(lead.id, state, "meeting_booked", "meeting_booked", detail);
  } else if (action === "booking_unexpected_state") {
    // A person with a meeting must not be drafted or sent to: hold for review.
    await deps.transition(lead.id, state, "manual_hold", "booking_unexpected_state", { ...detail, from_state: state });
    await raiseOnce(deps, {
      kind: "booking_unexpected_state",
      eventId,
      leadId: lead.id,
      escalate: true,
      detail: { from_state: state, held: true, meeting_id: meeting.id, meeting_external_id: meeting.external_id },
    });
  } else {
    await logMeetingEventOnce(deps.db, lead.id, "meeting_recorded", meeting.id, { ...detail, state_unchanged: state });
  }

  const stop = await stopSequence(
    { db: webhookDb(deps.db), instantly: deps.instantly, transition: deps.transition, alert: deps.alert, now: deps.now },
    lead.id,
    "meeting_booked",
    { eventId },
  );

  if (input.prep && meeting.status === "scheduled") {
    const inserted = await logMeetingEventOnce(deps.db, lead.id, "meeting_prep_due", meeting.id, {
      webhook_event_id: eventId,
      meeting_external_id: meeting.external_id,
      start_at: meeting.start_at,
      event_name: meeting.event_name,
      invitee_email: meeting.invitee_email,
      due_at: meeting.start_at,
    });
    if (inserted) {
      await deps.alert(
        `📅 Meeting booked · lead ${lead.id}\n` +
          `${meeting.invitee_name ?? meeting.invitee_email} — ${meeting.event_name ?? "Calendly meeting"} — ${fmt(meeting.start_at)}\n` +
          `Outreach stopped (${frozen.cancelled_jobs} job(s) cancelled, Instantly: ${stop.outcome}). Prep the meeting brief.`,
      );
    }
  }
  return { action, ...frozen, stop: stop.outcome };
}

// ---------------------------------------------------------------------------
// Operator-recorded outcome (held / no-show) — scripts/meeting-outcome.ts
// ---------------------------------------------------------------------------

export type OutcomeStatus = Extract<MeetingStatus, "held" | "no_show">;

export type OutcomePlan =
  | { ok: true; noop: boolean; from: MeetingStatus; to: OutcomeStatus; patch: Partial<MeetingRow> }
  | { ok: false; reason: string };

/** Pure: whether an operator may record `to` on a meeting in `from`. */
export function planOutcome(row: Pick<MeetingRow, "status" | "start_at">, to: OutcomeStatus, by: string, now: Date): OutcomePlan {
  const from = row.status;
  if (from === to) return { ok: true, noop: true, from, to, patch: {} };
  if (from === "canceled" || from === "rescheduled") {
    return { ok: false, reason: `meeting is ${from}; record the outcome on the live meeting` };
  }
  if (row.start_at && Date.parse(row.start_at) > now.getTime()) {
    return { ok: false, reason: `meeting starts ${row.start_at}, in the future` };
  }
  const at = now.toISOString();
  const patch: Partial<MeetingRow> = { status: to, outcome_recorded_by: by, outcome_recorded_at: at };
  patch.no_show_at = to === "no_show" ? at : null;
  return { ok: true, noop: false, from, to, patch };
}

export async function recordOutcome(
  db: MeetingsDb,
  meetingId: string,
  to: OutcomeStatus,
  by: string,
  now: Date,
): Promise<{ plan: OutcomePlan; row: MeetingRow }> {
  const row = await getMeeting(db, meetingId);
  if (!row) throw new WebhookProcessingError(`meeting not found: ${meetingId}`);
  const plan = planOutcome(row, to, by, now);
  if (!plan.ok || plan.noop) return { plan, row };
  const updated = await updateMeeting(db, row, plan.patch);
  if (row.lead_id) {
    await logMeetingEventOnce(db, row.lead_id, to === "held" ? "meeting_held" : "meeting_no_show", row.id, {
      recorded_by: by,
      recorded_at: now.toISOString(),
      from_status: plan.from,
      source: "operator",
    });
  }
  return { plan, row: updated };
}
