import { createHash, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { InstantlyClient } from "@/lib/integrations/instantly";
import { canonicalJson } from "@/lib/sending/approval";
import { normalizeEmail } from "@/lib/sending/suppression";
import type { createStateStore } from "@/lib/state/core";
import { instantlyWebhookSchema, type InstantlyWebhookPayload } from "@/lib/validation/external";
import { capacityDefaultsSchema } from "@/lib/validation/jsonb";
import type { Json } from "@/types/database";
import type { DatabaseWithWebhooks } from "@/types/database-extensions";
import type { LeadState } from "@/types/enums";

// Instantly webhooks (09 §U6, brief §10). The stop path:
//
//   1. Authenticate. Instantly has no HMAC signing; deliveries carry a static
//      header we configured on the webhook. Unset secret → 500, wrong or
//      missing token → 401. Either way ZERO rows are written.
//   2. Persist the raw event into webhook_events BEFORE processing. The payload
//      has no event id, so external_id is a hash of its identifying fields and
//      the (provider, external_id) unique index dedupes redeliveries.
//   3. Process. A human reply freezes outreach immediately — inbound touch,
//      queued jobs cancelled, pending touches killed, lead → replied — and
//      calls no model: classification is U7's job, after the freeze. An
//      auto-reply is NOT a reply (operator, Session 12): recorded, nothing
//      else. Unsubscribe → durable person-level suppression on every channel.
//      Bounce → invalid email, suppression, bounce-rate auto-pause.
//   4. Anything the engine cannot attribute goes to the exceptions queue with
//      zero lead mutations. A stop that fails is escalated to the operator.
//
// Ordering: events are applied against current state, never assumed to
// arrive in order. `email_sent` never regresses a later state, so a reply
// delivered before its `email_sent` still ends in `replied`.

export const WEBHOOK_TOKEN_HEADER = "x-zyndix-webhook-token";
const PROVIDER = "instantly";
const MAX_BODY_BYTES = 1_000_000;
const DAY_MS = 86_400_000;

type WebhookDb = SupabaseClient<DatabaseWithWebhooks>;

export type InstantlyWebhookDeps = {
  db: WebhookDb;
  /** The shared token Instantly sends in WEBHOOK_TOKEN_HEADER. Undefined = not configured. */
  secret: string | undefined;
  transition: ReturnType<typeof createStateStore>["transition"];
  /** Only the two stop operations. No model client exists here by design. */
  instantly: Pick<InstantlyClient, "addBlockListEntry" | "pauseCampaign">;
  getActiveSetting: (key: string) => Promise<{ version: number; value: unknown }>;
  alert: (text: string) => Promise<void>;
  now?: () => Date;
};

export type WebhookOutcome =
  | { kind: "duplicate"; eventId: string }
  | { kind: "processed"; eventId: string; action: string; leadId?: string }
  | { kind: "exception"; eventId: string; exception: ExceptionKind };

export type ExceptionKind = "unmatched_recipient" | "foreign_campaign" | "stop_failed" | "invalid_payload" | "unexpected_state";

export class WebhookProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookProcessingError";
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point (the route is a thin wrapper around this)
// ---------------------------------------------------------------------------

function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  // Hash both so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function handleInstantlyWebhook(req: Request, deps: InstantlyWebhookDeps): Promise<Response> {
  if (!deps.secret || deps.secret.length < 32) {
    console.error("[instantly] webhook refused: INSTANTLY_WEBHOOK_SECRET not configured");
    return Response.json({ error: "Webhook secret not configured" }, { status: 500 });
  }
  if (!tokenMatches(req.headers.get(WEBHOOK_TOKEN_HEADER), deps.secret)) {
    console.warn("[instantly] webhook rejected: missing or invalid token");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return Response.json({ error: "Payload too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid JSON object" }, { status: 400 });
  }

  try {
    const outcome = await processInstantlyEvent(deps, body as Record<string, unknown>);
    return Response.json({ ok: true, ...outcome });
  } catch (error) {
    // Stored with processing_error; a non-2xx makes Instantly redeliver, and
    // the redelivery replays the unprocessed row.
    console.error("[instantly] webhook processing failed:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Persist first
// ---------------------------------------------------------------------------

/** Deterministic id for a delivery: Instantly's payload carries none. */
export function instantlyExternalId(raw: Record<string, unknown>): string {
  const pick = (k: string) => (raw[k] === undefined ? null : raw[k]);
  const email = typeof raw.lead_email === "string" ? normalizeEmail(raw.lead_email) : pick("lead_email");
  const identity = {
    event_type: pick("event_type"),
    workspace: pick("workspace"),
    campaign_id: pick("campaign_id"),
    lead_email: email,
    email_id: pick("email_id"),
    step: pick("step"),
    timestamp: pick("timestamp"),
  };
  // A body without an event type is hashed whole, so distinct junk is distinct.
  const basis = typeof raw.event_type === "string" ? identity : raw;
  return `ix:${createHash("sha256").update(canonicalJson(basis)).digest("hex")}`;
}

async function persistEvent(
  db: WebhookDb,
  raw: Record<string, unknown>,
): Promise<{ id: string; duplicate: boolean; processed: boolean }> {
  const externalId = instantlyExternalId(raw);
  const eventType = typeof raw.event_type === "string" ? raw.event_type : "invalid";
  const { data, error } = await db
    .from("webhook_events")
    .insert({ provider: PROVIDER, external_id: externalId, event_type: eventType, payload: raw as Json, processed: false })
    .select("id")
    .single();
  if (!error && data) return { id: data.id, duplicate: false, processed: false };
  if (error?.code !== "23505") throw new WebhookProcessingError(`persist webhook_event: ${error?.message ?? "no row"}`);

  const { data: existing, error: loadError } = await db
    .from("webhook_events")
    .select("id, processed")
    .eq("provider", PROVIDER)
    .eq("external_id", externalId)
    .single();
  if (loadError || !existing) throw new WebhookProcessingError(`load duplicate webhook_event: ${loadError?.message}`);
  return { id: existing.id, duplicate: true, processed: Boolean(existing.processed) };
}

async function markProcessed(db: WebhookDb, eventId: string, now: Date): Promise<void> {
  const { error } = await db
    .from("webhook_events")
    .update({ processed: true, processed_at: now.toISOString(), processing_error: null })
    .eq("id", eventId);
  if (error) throw new WebhookProcessingError(`mark processed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export async function processInstantlyEvent(
  deps: InstantlyWebhookDeps,
  raw: Record<string, unknown>,
): Promise<WebhookOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const stored = await persistEvent(deps.db, raw);
  // A redelivery of a processed event changes nothing. An unprocessed one
  // (earlier failure) is replayed: every step below is idempotent.
  if (stored.duplicate && stored.processed) return { kind: "duplicate", eventId: stored.id };

  try {
    const outcome = await dispatch(deps, stored.id, raw, now);
    await markProcessed(deps.db, stored.id, now);
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.db.from("webhook_events").update({ processing_error: message.slice(0, 2000) }).eq("id", stored.id);
    throw error;
  }
}

async function dispatch(
  deps: InstantlyWebhookDeps,
  eventId: string,
  raw: Record<string, unknown>,
  now: Date,
): Promise<WebhookOutcome> {
  const parsed = instantlyWebhookSchema.safeParse(raw);
  if (!parsed.success) {
    await raiseException(deps, { kind: "invalid_payload", eventId, detail: { issues: parsed.error.issues.slice(0, 5) } });
    return { kind: "exception", eventId, exception: "invalid_payload" };
  }
  const p = parsed.data;

  const handler = handlerFor(p);
  if (!handler) return { kind: "processed", eventId, action: "recorded_only" };

  const match = await matchLead(deps, eventId, p);
  if (!match.ok) return { kind: "exception", eventId, exception: match.exception };

  return handler(deps, { eventId, payload: p, lead: match.lead, account: match.account, now });
}

type LeadMatch = {
  id: string;
  state: LeadState;
  email: string | null;
  send_account_id: string | null;
  company_id: string | null;
};
type AccountMatch = { id: string; identifier: string | null; instantly_campaign_id: string | null };
type HandlerInput = { eventId: string; payload: InstantlyWebhookPayload; lead: LeadMatch; account: AccountMatch | null; now: Date };
type Handler = (deps: InstantlyWebhookDeps, input: HandlerInput) => Promise<WebhookOutcome>;

function handlerFor(p: InstantlyWebhookPayload): Handler | null {
  if (isAutoReply(p)) return handleAutoReply;
  switch (p.event_type) {
    case "reply_received":
      return handleReply;
    case "lead_unsubscribed":
      return handleUnsubscribe;
    case "email_bounced":
      return handleBounce;
    case "email_sent":
      return handleSent;
    default:
      // opens, clicks, labels, campaign/account events: stored, no mutation.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Matching: our campaigns only, one lead, or an exception with no mutation
// ---------------------------------------------------------------------------

async function matchLead(
  deps: InstantlyWebhookDeps,
  eventId: string,
  p: InstantlyWebhookPayload,
): Promise<{ ok: true; lead: LeadMatch; account: AccountMatch | null } | { ok: false; exception: ExceptionKind }> {
  const { data: accounts, error: accountError } = await deps.db
    .from("send_accounts")
    .select("id, identifier, instantly_campaign_id");
  if (accountError) throw new WebhookProcessingError(`load send_accounts: ${accountError.message}`);
  const byCampaign = (accounts ?? []).find((a) => p.campaign_id && a.instantly_campaign_id === p.campaign_id) ?? null;
  const byMailbox =
    (accounts ?? []).find((a) => p.email_account && a.identifier && normalizeEmail(a.identifier) === normalizeEmail(p.email_account)) ?? null;
  const account = byCampaign ?? byMailbox;
  if (!account) {
    await raiseException(deps, {
      kind: "foreign_campaign",
      eventId,
      detail: { event_type: p.event_type, campaign_id: p.campaign_id ?? null, email_account: p.email_account ?? null },
    });
    return { ok: false, exception: "foreign_campaign" };
  }

  const email = normalizeEmail(p.lead_email ?? p.email ?? "");
  if (!email) {
    await raiseException(deps, { kind: "unmatched_recipient", eventId, detail: { event_type: p.event_type, reason: "no lead_email" } });
    return { ok: false, exception: "unmatched_recipient" };
  }
  const { data: leads, error } = await deps.db
    .from("leads")
    .select("id, state, email, send_account_id, company_id")
    .ilike("email", email.replace(/[\\%_]/g, (c) => `\\${c}`));
  if (error) throw new WebhookProcessingError(`match lead: ${error.message}`);
  const candidates = (leads ?? []).filter((l) => normalizeEmail(l.email ?? "") === email);
  const bound = candidates.filter((l) => l.send_account_id === account.id);
  const lead = candidates.length === 1 ? candidates[0] : bound.length === 1 ? bound[0] : null;
  if (!lead) {
    await raiseException(deps, {
      kind: "unmatched_recipient",
      eventId,
      detail: { event_type: p.event_type, lead_email: email, candidates: candidates.length },
    });
    return { ok: false, exception: "unmatched_recipient" };
  }
  return { ok: true, lead: { ...lead, state: lead.state as LeadState }, account };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const AUTO_REPLY_SUBJECT = /^\s*(automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|out of (the )?office|ooo\b|auto:)/i;

/**
 * Conservative on purpose: only an explicit provider flag, the auto-reply /
 * out-of-office event types, or an unmistakable auto-reply subject. A human
 * reply misread as automatic would keep outreach running — the one error that
 * matters — so anything unclear is treated as a human reply and freezes.
 */
export function isAutoReply(p: InstantlyWebhookPayload): boolean {
  if (p.event_type === "auto_reply_received" || p.event_type === "lead_out_of_office") return true;
  if (p.event_type !== "reply_received") return false;
  const flag = p.is_auto_reply;
  if (flag === true || flag === 1 || flag === "1" || flag === "true") return true;
  return AUTO_REPLY_SUBJECT.test(p.reply_subject ?? "");
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const CUE_RE = "(?:back|return(?:ing)?|returns|until|till|through|thru|in the office)";

function isoDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Next occurrence of month/day on or after `now` (minus a day) when no year is given. */
function withYear(m: number, d: number, year: number | null, now: Date): string | null {
  if (year !== null) return isoDate(year < 100 ? 2000 + year : year, m, d);
  const y = now.getUTCFullYear();
  const candidate = isoDate(y, m, d);
  if (candidate && Date.parse(candidate) >= now.getTime() - DAY_MS) return candidate;
  return isoDate(y + 1, m, d);
}

/**
 * A return date stated in an auto-reply, e.g. "back on October 5", "returning
 * 10/05/2026", "until 2026-10-05", "until 5 October". Only dates that follow a
 * return cue are read. Null when none is found — never a guess.
 */
export function parseReturnDate(text: string | null | undefined, now: Date): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ");
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => string | null]> = [
    [new RegExp(`${CUE_RE}[^.\\n]{0,30}?(\\d{4})-(\\d{2})-(\\d{2})`, "i"), (m) => isoDate(+m[1]!, +m[2]!, +m[3]!)],
    [
      new RegExp(`${CUE_RE}[^.\\n]{0,30}?${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?`, "i"),
      (m) => withYear(monthIndex(m[1]!), +m[2]!, m[3] ? +m[3] : null, now),
    ],
    [
      new RegExp(`${CUE_RE}[^.\\n]{0,30}?(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH_RE}(?:,? (\\d{4}))?`, "i"),
      (m) => withYear(monthIndex(m[2]!), +m[1]!, m[3] ? +m[3] : null, now),
    ],
    [
      new RegExp(`${CUE_RE}[^.\\n]{0,30}?(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?`, "i"),
      (m) => withYear(+m[1]!, +m[2]!, m[3] ? +m[3] : null, now),
    ],
  ];
  for (const [re, build] of patterns) {
    const m = t.match(re);
    if (m) {
      const date = build(m);
      if (date) return date;
    }
  }
  return null;
}

function monthIndex(token: string): number {
  const t = token.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((name) => name.startsWith(t)) + 1;
}

/** Auto-reply: recorded, nothing else — the lead stays where it is and nothing is cancelled. */
const handleAutoReply: Handler = async (deps, { eventId, payload, lead, now }) => {
  await logEvent(deps.db, lead.id, "auto_reply", {
    webhook_event_id: eventId,
    event_type: payload.event_type,
    email_id: payload.email_id ?? null,
    subject: payload.reply_subject ?? null,
    snippet: (payload.reply_text_snippet ?? payload.reply_text ?? "").slice(0, 280) || null,
    return_date: parseReturnDate(payload.reply_text ?? payload.reply_text_snippet, now),
  });
  return { kind: "processed", eventId, action: "auto_reply_recorded", leadId: lead.id };
};

const REPLY_FROZEN_STATES: readonly LeadState[] = ["replied", "classifying", "human_review", "meeting_booked", "handed_off"];
const TERMINAL_STATES: readonly LeadState[] = ["suppressed", "manual_hold", "bounced"];

/** Human reply: freeze first, classify later (U7). */
const handleReply: Handler = async (deps, { eventId, payload, lead, now }) => {
  const repliedAt = eventTime(payload, now);
  await recordInboundTouch(deps.db, lead.id, payload, repliedAt);
  await markLatestOutbound(deps.db, lead.id, { replied_at: repliedAt });
  const frozen = await freezeOutreach(deps.db, lead.id, now);
  const detail = { webhook_event_id: eventId, email_id: payload.email_id ?? null, ...frozen };

  const state = await currentState(deps.db, lead.id);
  if (state === "sent") {
    await deps.transition(lead.id, "sent", "replied", "reply_received", detail);
  } else if (state === "queued") {
    // The provider accepted the send even though our outbox is not settled
    // yet; the reply is proof. The reconcile job still settles the outbox.
    await deps.transition(lead.id, "queued", "sent", "sent_inferred_from_reply", { webhook_event_id: eventId });
    await deps.transition(lead.id, "sent", "replied", "reply_received", detail);
  } else if (state && (REPLY_FROZEN_STATES.includes(state) || TERMINAL_STATES.includes(state))) {
    await logEvent(deps.db, lead.id, "reply_received", { ...detail, state_unchanged: state });
  } else {
    // A reply for a lead we never sent to: hold it and ask a human.
    if (state) await deps.transition(lead.id, state, "manual_hold", "reply_unexpected_state", { ...detail, from_state: state });
    await raiseException(deps, { kind: "unexpected_state", eventId, leadId: lead.id, detail: { event_type: payload.event_type, state } });
  }
  return { kind: "processed", eventId, action: "reply_frozen", leadId: lead.id };
};

/** Opt-out: durable person-level suppression, every channel stopped. */
const handleUnsubscribe: Handler = async (deps, { eventId, payload, lead, now }) => {
  const email = normalizeEmail(lead.email ?? payload.lead_email ?? "");
  await ensureSuppressed(deps.db, email, "unsubscribe", await latestOutboundTouchId(deps.db, lead.id));
  const { error } = await deps.db.from("leads").update({ do_not_contact: true }).eq("id", lead.id);
  if (error) throw new WebhookProcessingError(`do_not_contact: ${error.message}`);
  const frozen = await freezeOutreach(deps.db, lead.id, now);

  const state = await currentState(deps.db, lead.id);
  if (state && state !== "suppressed") {
    await deps.transition(lead.id, state, "suppressed", "unsubscribed", { webhook_event_id: eventId, ...frozen });
  } else {
    await logEvent(deps.db, lead.id, "unsubscribed", { webhook_event_id: eventId, ...frozen, state_unchanged: state });
  }

  // Provider-side stop across every campaign. The engine is already stopped
  // (suppression + state); a failure here is escalated, never ignored.
  try {
    await deps.instantly.addBlockListEntry(email);
  } catch (error) {
    await raiseException(deps, {
      kind: "stop_failed",
      eventId,
      leadId: lead.id,
      escalate: true,
      detail: { stop: "instantly_block_list", error: error instanceof Error ? error.message : String(error) },
    });
  }
  return { kind: "processed", eventId, action: "suppressed", leadId: lead.id };
};

/** Bounce: the address is invalid; suppress it and check the sender's bounce rate. */
const handleBounce: Handler = async (deps, { eventId, payload, lead, account, now }) => {
  const email = normalizeEmail(lead.email ?? payload.lead_email ?? "");
  const { error } = await deps.db.from("leads").update({ email_status: "invalid" }).eq("id", lead.id);
  if (error) throw new WebhookProcessingError(`email_status invalid: ${error.message}`);
  const touchId = await latestOutboundTouchId(deps.db, lead.id);
  await ensureSuppressed(deps.db, email, "bounce", touchId);
  await markLatestOutbound(deps.db, lead.id, { status: "bounced" });
  const frozen = await freezeOutreach(deps.db, lead.id, now);

  const state = await currentState(deps.db, lead.id);
  const detail = { webhook_event_id: eventId, ...frozen };
  if (state === "sent") {
    await deps.transition(lead.id, "sent", "bounced", "bounced", detail);
  } else if (state === "queued") {
    await deps.transition(lead.id, "queued", "sent", "sent_inferred_from_bounce", { webhook_event_id: eventId });
    await deps.transition(lead.id, "sent", "bounced", "bounced", detail);
  } else {
    await logEvent(deps.db, lead.id, "bounced", { ...detail, state_unchanged: state });
  }

  const accountId = lead.send_account_id ?? account?.id ?? null;
  if (accountId) await checkBounceRate(deps, eventId, accountId, now);
  return { kind: "processed", eventId, action: "bounced", leadId: lead.id };
};

/** Provider confirms a send. Never regresses a later state. */
const handleSent: Handler = async (deps, { eventId, payload, lead, account }) => {
  // Step 1's Instantly email id is the thread anchor for follow-ups.
  if (payload.email_id && account?.instantly_campaign_id && payload.campaign_id === account.instantly_campaign_id) {
    const { error } = await deps.db
      .from("outbox")
      .update({ provider_email_id: payload.email_id })
      .eq("lead_id", lead.id)
      .eq("operation", "enroll")
      .is("provider_email_id", null)
      .in("state", ["accepted", "reconciled_sent", "uncertain"]);
    if (error) throw new WebhookProcessingError(`outbox anchor: ${error.message}`);
  }
  const state = await currentState(deps.db, lead.id);
  if (state === "queued") {
    await deps.transition(lead.id, "queued", "sent", "sent_confirmed_by_webhook", { webhook_event_id: eventId });
  } else {
    await logEvent(deps.db, lead.id, "provider_email_sent", {
      webhook_event_id: eventId,
      email_id: payload.email_id ?? null,
      step: payload.step ?? null,
      state_unchanged: state,
    });
  }
  return { kind: "processed", eventId, action: "sent_recorded", leadId: lead.id };
};

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

function eventTime(p: InstantlyWebhookPayload, now: Date): string {
  const t = typeof p.timestamp === "number" ? p.timestamp : p.timestamp ? Date.parse(p.timestamp) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : now.toISOString();
}

async function currentState(db: WebhookDb, leadId: string): Promise<LeadState | null> {
  const { data, error } = await db.from("leads").select("state").eq("id", leadId).maybeSingle();
  if (error) throw new WebhookProcessingError(`lead reload: ${error.message}`);
  return (data?.state as LeadState | undefined) ?? null;
}

async function logEvent(db: WebhookDb, leadId: string, event: string, detail: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("lead_events").insert({ lead_id: leadId, event, detail: detail as Json });
  if (error) throw new WebhookProcessingError(`lead_event ${event}: ${error.message}`);
}

/** The reply as an inbound touch; this alone makes preflight refuse `reply_freeze`. Idempotent per email id. */
async function recordInboundTouch(db: WebhookDb, leadId: string, p: InstantlyWebhookPayload, repliedAt: string): Promise<void> {
  if (p.email_id) {
    const { data: existing, error } = await db
      .from("touches")
      .select("id")
      .eq("lead_id", leadId)
      .eq("direction", "inbound")
      .eq("provider_message_id", p.email_id)
      .limit(1);
    if (error) throw new WebhookProcessingError(`inbound touch lookup: ${error.message}`);
    if ((existing ?? []).length > 0) return;
  }
  const { error } = await db.from("touches").insert({
    lead_id: leadId,
    channel: "email",
    direction: "inbound",
    status: "replied",
    subject: p.reply_subject ?? null,
    reply_body: p.reply_text ?? p.reply_text_snippet ?? null,
    replied_at: repliedAt,
    provider_message_id: p.email_id ?? null,
  });
  if (error) throw new WebhookProcessingError(`inbound touch: ${error.message}`);
}

async function latestOutboundTouchId(db: WebhookDb, leadId: string): Promise<string | null> {
  const { data, error } = await db
    .from("touches")
    .select("id")
    .eq("lead_id", leadId)
    .eq("direction", "outbound")
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1);
  if (error) throw new WebhookProcessingError(`latest outbound: ${error.message}`);
  return data?.[0]?.id ?? null;
}

async function markLatestOutbound(db: WebhookDb, leadId: string, patch: { replied_at?: string; status?: string }): Promise<void> {
  const id = await latestOutboundTouchId(db, leadId);
  if (!id) return;
  const { error } = await db.from("touches").update(patch).eq("id", id);
  if (error) throw new WebhookProcessingError(`outbound touch update: ${error.message}`);
}

const KILLABLE_TOUCH_STATUSES = ["drafted", "pending_approval", "approved", "edited"];

/**
 * Stops everything not yet dispatched for this lead, on every channel: queued
 * jobs referencing its touches or the lead are cancelled, and outbound touches
 * that have not left are killed. A job already leased is stopped by the send
 * stage's second preflight, which sees the reply/suppression written here.
 */
async function freezeOutreach(db: WebhookDb, leadId: string, now: Date): Promise<{ cancelled_jobs: number; killed_touches: number }> {
  const { data: touches, error } = await db.from("touches").select("id, status, direction").eq("lead_id", leadId);
  if (error) throw new WebhookProcessingError(`freeze load touches: ${error.message}`);
  const touchIds = (touches ?? []).map((t) => t.id);

  let cancelled = 0;
  const finished = now.toISOString();
  if (touchIds.length) {
    const { data, error: jobError } = await db
      .from("jobs")
      .update({ state: "cancelled", finished_at: finished, last_error: "frozen by webhook" })
      .eq("state", "queued")
      .in("payload->>touch_id", touchIds)
      .select("id");
    if (jobError) throw new WebhookProcessingError(`cancel touch jobs: ${jobError.message}`);
    cancelled += (data ?? []).length;
  }
  const { data: leadJobs, error: leadJobError } = await db
    .from("jobs")
    .update({ state: "cancelled", finished_at: finished, last_error: "frozen by webhook" })
    .eq("state", "queued")
    .eq("payload->>lead_id", leadId)
    .select("id");
  if (leadJobError) throw new WebhookProcessingError(`cancel lead jobs: ${leadJobError.message}`);
  cancelled += (leadJobs ?? []).length;

  const killable = (touches ?? [])
    .filter((t) => t.direction !== "inbound" && KILLABLE_TOUCH_STATUSES.includes(t.status ?? ""))
    .map((t) => t.id);
  if (killable.length) {
    const { error: killError } = await db.from("touches").update({ status: "killed" }).in("id", killable);
    if (killError) throw new WebhookProcessingError(`kill touches: ${killError.message}`);
  }
  return { cancelled_jobs: cancelled, killed_touches: killable.length };
}

/** Person-level suppression (email set → never company-wide). Idempotent. */
async function ensureSuppressed(db: WebhookDb, email: string, reason: string, sourceTouchId: string | null): Promise<void> {
  if (!email) throw new WebhookProcessingError("suppression without an email");
  const { data: existing, error } = await db
    .from("suppression_list")
    .select("id")
    .ilike("email", email.replace(/[\\%_]/g, (c) => `\\${c}`))
    .limit(1);
  if (error) throw new WebhookProcessingError(`suppression lookup: ${error.message}`);
  if ((existing ?? []).length > 0) return;
  const { error: insertError } = await db
    .from("suppression_list")
    .insert({ email, domain: email.split("@")[1] ?? null, reason, source_touch_id: sourceTouchId });
  if (insertError) throw new WebhookProcessingError(`suppression insert: ${insertError.message}`);
}

/** bounce_rate_7d = bounced / sent over the last 7 days; above the auto_pause threshold → paused. */
async function checkBounceRate(deps: InstantlyWebhookDeps, eventId: string, accountId: string, now: Date): Promise<void> {
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const { data: sent, error } = await deps.db
    .from("touches")
    .select("status")
    .eq("send_account_id", accountId)
    .eq("direction", "outbound")
    .gte("sent_at", since);
  if (error) throw new WebhookProcessingError(`bounce rate: ${error.message}`);
  const total = (sent ?? []).length;
  if (total === 0) return;
  const rate = (sent ?? []).filter((t) => t.status === "bounced").length / total;

  const defaults = capacityDefaultsSchema.parse((await deps.getActiveSetting("capacity_defaults")).value);
  const threshold = defaults.auto_pause.bounce_rate_7d;
  const paused = rate > threshold;
  const { data: account, error: accountError } = await deps.db
    .from("send_accounts")
    .update({
      bounce_rate_7d: rate,
      ...(paused ? { health: "paused", paused_reason: `bounce_rate_7d ${rate.toFixed(3)} > ${threshold}` } : {}),
    })
    .eq("id", accountId)
    .select("identifier, instantly_campaign_id")
    .single();
  if (accountError) throw new WebhookProcessingError(`bounce rate update: ${accountError.message}`);
  if (!paused) return;

  let campaignPaused = false;
  if (account?.instantly_campaign_id) {
    try {
      await deps.instantly.pauseCampaign(account.instantly_campaign_id);
      campaignPaused = true;
    } catch (pauseError) {
      await raiseException(deps, {
        kind: "stop_failed",
        eventId,
        escalate: true,
        detail: {
          stop: "instantly_pause_campaign",
          send_account_id: accountId,
          error: pauseError instanceof Error ? pauseError.message : String(pauseError),
        },
      });
    }
  }
  await deps.alert(
    `⛔ Sender auto-paused: ${account?.identifier ?? accountId}\n` +
      `bounce_rate_7d ${(rate * 100).toFixed(1)}% > ${(threshold * 100).toFixed(1)}% (${total} sent in 7d)\n` +
      `Engine: health=paused. Instantly campaign pause: ${campaignPaused ? "done" : "NOT done — see exceptions"}.`,
  );
}

async function raiseException(
  deps: InstantlyWebhookDeps,
  input: { kind: ExceptionKind; eventId: string; leadId?: string; detail: Record<string, unknown>; escalate?: boolean },
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const { error } = await deps.db.from("exceptions").insert({
    kind: input.kind,
    provider: PROVIDER,
    webhook_event_id: input.eventId,
    lead_id: input.leadId ?? null,
    detail: input.detail as Json,
    status: input.escalate ? "escalated" : "open",
    escalated_at: input.escalate ? now : null,
  });
  if (error) throw new WebhookProcessingError(`exception insert: ${error.message}`);
  if (input.escalate) {
    await deps.alert(`⚠️ Instantly ${input.kind}${input.leadId ? ` · lead ${input.leadId}` : ""}\n${JSON.stringify(input.detail).slice(0, 400)}`);
  }
}
