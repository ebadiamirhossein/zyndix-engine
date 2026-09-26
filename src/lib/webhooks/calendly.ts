import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  applyBookingStop,
  type BookingDeps,
  cancellationFields,
  ensureMeeting,
  findMeeting,
  type LeadRef,
  loadLead,
  logMeetingEventOnce,
  matchLeadsByEmail,
  type MeetingRow,
  meetingFieldsFromInvitee,
  raiseOnce,
  updateMeeting,
} from "@/lib/meetings/core";
import { canonicalJson } from "@/lib/sending/approval";
import {
  CALENDLY_INVITEE_EVENTS,
  type CalendlyInvitee,
  type CalendlyWebhookPayload,
  calendlyWebhookSchema,
} from "@/lib/validation/external";
import type { Json } from "@/types/database";
import type { DatabaseWithWebhooks } from "@/types/database-extensions";

import type { ExceptionKind } from "./exceptions";
import { markFailed, markProcessed, persistEvent } from "./persist";

// Calendly webhooks (09 §U8, brief §9 Calendly row, §10). The path:
//
//   1. Authenticate before anything is written. Calendly signs each delivery:
//      `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex>` where v1 is
//      HMAC-SHA256(signing key, `${t}.${raw body}`). Verified on the raw bytes
//      before JSON.parse, timing-safe, with a 3-minute tolerance on `t` in
//      both directions. Unset key → 500; missing, bad or stale signature →
//      401. Either way ZERO rows are written.
//   2. Persist the raw event into webhook_events BEFORE processing (persist.ts),
//      keyed `<event>:<invitee uri>` so created and canceled of one invitee are
//      distinct and a redelivery is a no-op.
//   3. Match the invitee email to a lead. No lead → the meeting is still
//      stored (lead_id null) and one escalated `calendly_unmatched_invitee`
//      exception is raised; no lead is touched.
//   4. Apply the event (lib/meetings/core.ts). A booking stops outreach. A
//      cancellation or reschedule never restarts it: no job is created and no
//      lead moves back to a sending state.
//
// Ordering: on a reschedule Calendly fires invitee.created (new invitee,
// `old_invitee` set) AND invitee.canceled (old invitee, `rescheduled: true`,
// `new_invitee` set), in either order. Both link the two rows, so either order
// ends in the same place. Any event that reveals a booking the engine never
// saw (created lost, or delivered later) applies the booking stop itself —
// idempotently — so a late or missing invitee.created cannot leave a booked
// person in cold outreach.

export const CALENDLY_SIGNATURE_HEADER = "calendly-webhook-signature";
/** Calendly's documented example tolerance ("3 minutes"); applied to past AND future timestamps. */
export const SIGNATURE_TOLERANCE_MS = 3 * 60_000;
/** We choose the signing key when creating the subscription; a short one is treated as unset. */
export const MIN_SIGNING_KEY_LENGTH = 32;
const PROVIDER = "calendly";
const MAX_BODY_BYTES = 1_000_000;

type WebhookDb = SupabaseClient<DatabaseWithWebhooks>;

export type CalendlyWebhookDeps = BookingDeps & {
  /** CALENDLY_WEBHOOK_SIGNING_KEY. Undefined = not configured (fails closed). */
  signingKey: string | undefined;
};

export type CalendlyOutcome =
  | { kind: "duplicate"; eventId: string }
  | { kind: "processed"; eventId: string; action: string; leadId?: string; meetingId?: string }
  | { kind: "exception"; eventId: string; exception: ExceptionKind; meetingId?: string };

// ---------------------------------------------------------------------------
// Signature (pure)
// ---------------------------------------------------------------------------

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "missing" | "malformed" | "mismatch" | "stale" };

/** Parses `t=…,v1=…`. Null when there is no single numeric `t` or no `v1`. */
export function parseSignatureHeader(header: string | null | undefined): { t: string; v1: string[] } | null {
  if (!header) return null;
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") {
      if (t !== null) return null; // two timestamps: ambiguous, refuse
      t = v;
    } else if (k === "v1" && v) {
      v1.push(v);
    }
  }
  if (!t || !/^\d{1,12}$/.test(t) || !v1.length) return null;
  return { t, v1 };
}

/** HMAC-SHA256(key, `${t}.${body}`) as lowercase hex. */
export function computeCalendlySignature(key: string, t: string, rawBody: string | Uint8Array): string {
  return createHmac("sha256", key).update(`${t}.`).update(rawBody).digest("hex");
}

export function verifyCalendlySignature(input: {
  header: string | null | undefined;
  rawBody: string | Uint8Array;
  key: string;
  now: Date;
}): SignatureCheck {
  if (!input.header) return { ok: false, reason: "missing" };
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(computeCalendlySignature(input.key, parsed.t, input.rawBody), "utf8");
  const match = parsed.v1.some((candidate) => {
    const presented = Buffer.from(candidate.toLowerCase(), "utf8");
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  });
  if (!match) return { ok: false, reason: "mismatch" };
  const timestamp = Number(parsed.t) * 1000;
  if (Math.abs(input.now.getTime() - timestamp) > SIGNATURE_TOLERANCE_MS) return { ok: false, reason: "stale" };
  return { ok: true, timestamp };
}

// ---------------------------------------------------------------------------
// HTTP entry point (the route is a thin wrapper around this)
// ---------------------------------------------------------------------------

export async function handleCalendlyWebhook(req: Request, deps: CalendlyWebhookDeps): Promise<Response> {
  if (!deps.signingKey || deps.signingKey.length < MIN_SIGNING_KEY_LENGTH) {
    console.error("[calendly] webhook refused: CALENDLY_WEBHOOK_SIGNING_KEY not configured");
    return Response.json({ error: "Webhook signing key not configured" }, { status: 500 });
  }
  const header = req.headers.get(CALENDLY_SIGNATURE_HEADER);
  if (!header) {
    console.warn("[calendly] webhook rejected: missing signature");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return Response.json({ error: "Payload too large" }, { status: 413 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return Response.json({ error: "Payload too large" }, { status: 413 });

  // Verified against the exact bytes received, before any parsing.
  const check = verifyCalendlySignature({ header, rawBody: bytes, key: deps.signingKey, now: clock(deps) });
  if (!check.ok) {
    console.warn(`[calendly] webhook rejected: signature ${check.reason}`);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid JSON object" }, { status: 400 });
  }

  try {
    const outcome = await processCalendlyEvent(deps, body as Record<string, unknown>);
    return Response.json({ ok: true, ...outcome });
  } catch (error) {
    // Stored with processing_error; a non-2xx makes Calendly redeliver and
    // the redelivery replays the unprocessed row.
    console.error("[calendly] webhook processing failed:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }
}

function clock(deps: { now?: () => Date }): Date {
  return (deps.now ?? (() => new Date()))();
}

// ---------------------------------------------------------------------------
// Persist first
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Dedupe id. invitee.created / invitee.canceled → `<event>:<invitee uri>`;
 * invitee_no_show.* → `<event>:<no_show uri>` when present, else
 * `<event>:<invitee uri>:<created_at>` (a no-show can be set, removed and set
 * again for one invitee); anything else → a hash of the whole body.
 */
export function calendlyExternalId(raw: Record<string, unknown>): string {
  const event = typeof raw.event === "string" ? raw.event : null;
  const payload = isObject(raw.payload) ? raw.payload : null;
  const inviteeUri = typeof payload?.uri === "string" && payload.uri ? payload.uri : null;
  if (event && inviteeUri && (event === "invitee.created" || event === "invitee.canceled")) return `${event}:${inviteeUri}`;
  if (event && inviteeUri && event.startsWith("invitee_no_show.")) {
    const noShow = isObject(payload?.no_show) && typeof payload.no_show.uri === "string" ? payload.no_show.uri : null;
    if (noShow) return `${event}:${noShow}`;
    return `${event}:${inviteeUri}:${typeof raw.created_at === "string" ? raw.created_at : ""}`;
  }
  return `cal:${createHash("sha256").update(canonicalJson(raw)).digest("hex")}`;
}

export async function processCalendlyEvent(deps: CalendlyWebhookDeps, raw: Record<string, unknown>): Promise<CalendlyOutcome> {
  const db = deps.db as unknown as WebhookDb;
  const stored = await persistEvent(db, {
    provider: PROVIDER,
    externalId: calendlyExternalId(raw),
    eventType: typeof raw.event === "string" ? raw.event : "invalid",
    raw,
  });
  // A processed redelivery changes nothing; an unprocessed one (an earlier
  // failure) is replayed — every step below is idempotent.
  if (stored.duplicate && stored.processed) return { kind: "duplicate", eventId: stored.id };

  try {
    const outcome = await dispatch(deps, stored.id, raw);
    await markProcessed(db, stored.id, clock(deps));
    return outcome;
  } catch (error) {
    await markFailed(db, stored.id, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

type Ctx = {
  deps: CalendlyWebhookDeps;
  eventId: string;
  p: CalendlyWebhookPayload;
  inv: CalendlyInvitee;
  /** Ranked leads sharing the invitee email (primary first). */
  leads: LeadRef[];
};

async function dispatch(deps: CalendlyWebhookDeps, eventId: string, raw: Record<string, unknown>): Promise<CalendlyOutcome> {
  // A subscription may include other events (event_type.*, routing forms…):
  // stored above, nothing else.
  if (typeof raw.event === "string" && !(CALENDLY_INVITEE_EVENTS as readonly string[]).includes(raw.event)) {
    return { kind: "processed", eventId, action: "recorded_only" };
  }
  const parsed = calendlyWebhookSchema.safeParse(raw);
  if (!parsed.success) {
    await raiseOnce(deps, { kind: "invalid_payload", eventId, detail: { issues: parsed.error.issues.slice(0, 5) } });
    return { kind: "exception", eventId, exception: "invalid_payload" };
  }
  const p = parsed.data;
  const ctx: Ctx = { deps, eventId, p, inv: p.payload, leads: await matchLeadsByEmail(deps.db, p.payload.email) };
  switch (p.event) {
    case "invitee.created":
      return onCreated(ctx);
    case "invitee.canceled":
      return p.payload.rescheduled ? onRescheduledAway(ctx) : onCanceled(ctx);
    case "invitee_no_show.created":
      return onNoShow(ctx, true);
    case "invitee_no_show.deleted":
      return onNoShow(ctx, false);
  }
}

/** The lead for this event: the email match, else the lead already on this invitee's row or a linked one. */
async function resolveLead(ctx: Ctx, ...linked: Array<MeetingRow | null>): Promise<LeadRef | null> {
  if (ctx.leads[0]) return ctx.leads[0];
  for (const row of linked) {
    if (row?.lead_id) return loadLead(ctx.deps.db, row.lead_id);
  }
  return null;
}

/** New row fields: provider facts + the lead link + the creating event. */
function insertFields(ctx: Ctx, lead: LeadRef | null) {
  return {
    ...meetingFieldsFromInvitee(ctx.inv),
    lead_id: lead?.id ?? null,
    company_id: lead?.company_id ?? null,
    webhook_event_id: ctx.eventId,
    raw: ctx.p as unknown as Json,
  };
}

/** Fills a missing lead link on an existing row (never replaces one). */
function linkPatch(row: MeetingRow, lead: LeadRef | null): Partial<MeetingRow> {
  return row.lead_id || !lead ? {} : { lead_id: lead.id, company_id: lead.company_id };
}

/** True when this row was created by this very event (a replay of a half-finished attempt). */
function ownRow(ctx: Ctx, row: MeetingRow | null, created: boolean): boolean {
  return created || (row !== null && row.webhook_event_id === ctx.eventId);
}

/**
 * The booking stop for the primary lead (with the prep task when asked) and
 * for every other lead sharing the email (no prep): a meeting stops outreach
 * to the person, whichever lead row they sit on.
 */
async function bookAll(ctx: Ctx, lead: LeadRef, meeting: MeetingRow, prep: boolean): Promise<string> {
  const result = await applyBookingStop(ctx.deps, { eventId: ctx.eventId, lead, meeting, prep });
  for (const other of ctx.leads) {
    if (other.id === lead.id) continue;
    await applyBookingStop(ctx.deps, { eventId: ctx.eventId, lead: other, meeting, prep: false, duplicateOf: lead.id });
  }
  return result.action;
}

async function unmatched(ctx: Ctx, meeting: MeetingRow, knownBefore: boolean): Promise<CalendlyOutcome> {
  if (!knownBefore) {
    await raiseOnce(ctx.deps, {
      kind: "calendly_unmatched_invitee",
      eventId: ctx.eventId,
      escalate: true,
      detail: {
        event: ctx.p.event,
        invitee_email: meeting.invitee_email,
        invitee_uri: ctx.inv.uri,
        meeting_id: meeting.id,
        start_at: meeting.start_at,
        event_name: meeting.event_name,
      },
    });
  }
  return { kind: "exception", eventId: ctx.eventId, exception: "calendly_unmatched_invitee", meetingId: meeting.id };
}

/** invitee.created: a new booking, or the new half of a reschedule. */
async function onCreated(ctx: Ctx): Promise<CalendlyOutcome> {
  const { deps, inv } = ctx;
  const oldRow = inv.old_invitee ? await findMeeting(deps.db, inv.old_invitee) : null;
  const lead = await resolveLead(ctx, await findMeeting(deps.db, inv.uri), oldRow);
  const ensured = await ensureMeeting(deps.db, { ...insertFields(ctx, lead), status: "scheduled", rescheduled_from: inv.old_invitee });
  let row = ensured.row;
  const own = ownRow(ctx, row, ensured.created);
  if (!own) {
    // Seen before (canceled / no-show delivered first, or an older duplicate):
    // refresh times only while it is still scheduled; never revive a status.
    const facts = meetingFieldsFromInvitee(inv);
    row = await updateMeeting(deps.db, row, {
      ...linkPatch(row, lead),
      ...(row.status === "scheduled" ? { start_at: facts.start_at, end_at: facts.end_at } : {}),
      ...(inv.old_invitee && !row.rescheduled_from ? { rescheduled_from: inv.old_invitee } : {}),
    });
  }

  if (inv.old_invitee) {
    // Reschedule: link the old row (either delivery order); no state change.
    if (oldRow) {
      await updateMeeting(deps.db, oldRow, {
        rescheduled_to: inv.uri,
        ...(oldRow.status === "scheduled" || oldRow.status === "canceled" ? { status: "rescheduled" as const } : {}),
      });
    }
    const knownBefore = !own || oldRow !== null;
    if (!lead) return unmatched(ctx, row, knownBefore);
    if (!knownBefore) {
      // The engine never saw the original booking: treat it as one.
      await raiseOnce(deps, {
        kind: "meeting_reschedule_unlinked",
        eventId: ctx.eventId,
        leadId: lead.id,
        detail: { invitee_uri: inv.uri, old_invitee: inv.old_invitee, meeting_id: row.id },
      });
      const action = await bookAll(ctx, lead, row, true);
      return { kind: "processed", eventId: ctx.eventId, action: `reschedule_unlinked:${action}`, leadId: lead.id, meetingId: row.id };
    }
    const logged = await logMeetingEventOnce(deps.db, lead.id, "meeting_rescheduled", row.id, {
      webhook_event_id: ctx.eventId,
      from_invitee: inv.old_invitee,
      to_invitee: inv.uri,
      start_at: row.start_at,
      previous_start_at: oldRow?.start_at ?? null,
    });
    if (logged) {
      await deps.alert(`🔁 Meeting rescheduled · lead ${lead.id}\n${row.invitee_name ?? row.invitee_email} → ${row.start_at ?? "time unknown"}. Outreach stays stopped.`);
    }
    return { kind: "processed", eventId: ctx.eventId, action: "rescheduled", leadId: lead.id, meetingId: row.id };
  }

  if (!lead) return unmatched(ctx, row, !own);
  const action = await bookAll(ctx, lead, row, true);
  return { kind: "processed", eventId: ctx.eventId, action, leadId: lead.id, meetingId: row.id };
}

/** invitee.canceled with rescheduled: true — the old half of a reschedule. */
async function onRescheduledAway(ctx: Ctx): Promise<CalendlyOutcome> {
  const { deps, inv, p } = ctx;
  const newRow = inv.new_invitee ? await findMeeting(deps.db, inv.new_invitee) : null;
  const lead = await resolveLead(ctx, await findMeeting(deps.db, inv.uri), newRow);
  const cancel = cancellationFields(inv, p.created_at);
  const ensured = await ensureMeeting(deps.db, {
    ...insertFields(ctx, lead),
    status: "rescheduled",
    rescheduled_to: inv.new_invitee,
    ...cancel,
  });
  let row = ensured.row;
  const own = ownRow(ctx, row, ensured.created);
  if (!own) {
    row = await updateMeeting(deps.db, row, {
      ...linkPatch(row, lead),
      ...(row.status === "scheduled" || row.status === "canceled" ? { status: "rescheduled" as const } : {}),
      ...(inv.new_invitee ? { rescheduled_to: inv.new_invitee } : {}),
      ...(row.canceled_at ? {} : cancel),
    });
  }
  if (newRow && !newRow.rescheduled_from) await updateMeeting(deps.db, newRow, { rescheduled_from: inv.uri });

  const knownBefore = !own || newRow !== null;
  if (!lead) return unmatched(ctx, row, knownBefore);
  if (!knownBefore) {
    // First the engine hears of this person's booking: the new meeting is
    // live, so stop outreach now; the new invitee.created will link to this row.
    await raiseOnce(deps, {
      kind: "meeting_reschedule_unlinked",
      eventId: ctx.eventId,
      leadId: lead.id,
      detail: { invitee_uri: inv.uri, new_invitee: inv.new_invitee, meeting_id: row.id },
    });
    const action = await bookAll(ctx, lead, row, false);
    return { kind: "processed", eventId: ctx.eventId, action: `reschedule_unlinked:${action}`, leadId: lead.id, meetingId: row.id };
  }
  return { kind: "processed", eventId: ctx.eventId, action: "rescheduled_away", leadId: lead.id, meetingId: row.id };
}

/** invitee.canceled (a real cancellation). The lead stays where it is; nothing restarts. */
async function onCanceled(ctx: Ctx): Promise<CalendlyOutcome> {
  const { deps, inv, p } = ctx;
  const lead = await resolveLead(ctx, await findMeeting(deps.db, inv.uri));
  const cancel = cancellationFields(inv, p.created_at);
  const ensured = await ensureMeeting(deps.db, { ...insertFields(ctx, lead), status: "canceled", ...cancel });
  let row = ensured.row;
  const own = ownRow(ctx, row, ensured.created);
  if (!own) {
    row = await updateMeeting(deps.db, row, {
      ...linkPatch(row, lead),
      ...(row.status === "scheduled" ? { status: "canceled" as const, ...cancel } : {}),
    });
  }
  if (!lead) return unmatched(ctx, row, !own);
  if (own) {
    // Canceled before its invitee.created arrived (or that was lost): the
    // person did book, so the booking stop applies — no prep, nothing restarts.
    await bookAll(ctx, lead, row, false);
  }
  const logged = await logMeetingEventOnce(deps.db, lead.id, "meeting_canceled", row.id, {
    webhook_event_id: ctx.eventId,
    canceled_by: row.canceled_by,
    canceler_type: row.canceler_type,
    reason: row.cancel_reason,
    outreach_restarted: false,
  });
  if (logged) {
    await deps.alert(
      `❌ Meeting canceled · lead ${lead.id}\n${row.invitee_name ?? row.invitee_email}${row.cancel_reason ? ` — "${row.cancel_reason.slice(0, 200)}"` : ""}\n` +
        `Cold outreach is NOT restarted; decide the next step by hand.`,
    );
  }
  return { kind: "processed", eventId: ctx.eventId, action: "canceled", leadId: lead.id, meetingId: row.id };
}

/** invitee_no_show.created → no_show; .deleted → back to scheduled (only from no_show). */
async function onNoShow(ctx: Ctx, created: boolean): Promise<CalendlyOutcome> {
  const { deps, inv, p } = ctx;
  const lead = await resolveLead(ctx, await findMeeting(deps.db, inv.uri));
  const noShowAt = new Date(inv.no_show?.created_at ?? p.created_at).toISOString();
  const initial = created
    ? { status: "no_show" as const, no_show_at: noShowAt }
    : { status: inv.status === "canceled" ? ("canceled" as const) : ("scheduled" as const) };
  const ensured = await ensureMeeting(deps.db, { ...insertFields(ctx, lead), ...initial });
  let row = ensured.row;
  const own = ownRow(ctx, row, ensured.created);
  if (!own) {
    const statusPatch: Partial<MeetingRow> = created
      ? row.status === "scheduled" || row.status === "held"
        ? { status: "no_show", no_show_at: noShowAt }
        : {}
      : row.status === "no_show"
        ? { status: "scheduled", no_show_at: null }
        : {};
    row = await updateMeeting(deps.db, row, { ...linkPatch(row, lead), ...statusPatch });
  }
  if (!lead) return unmatched(ctx, row, !own);
  if (own) await bookAll(ctx, lead, row, false);
  const event = created ? "meeting_no_show" : "meeting_no_show_removed";
  await logMeetingEventOnce(deps.db, lead.id, event, row.id, { webhook_event_id: ctx.eventId, source: "calendly", status: row.status });
  return { kind: "processed", eventId: ctx.eventId, action: created ? "no_show" : "no_show_removed", leadId: lead.id, meetingId: row.id };
}
