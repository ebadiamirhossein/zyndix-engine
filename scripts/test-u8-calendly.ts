import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { spawnSync } from "node:child_process";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import { InstantlyPermanentError } from "../src/lib/integrations/instantly";
import { ledgerDate } from "../src/lib/scheduler/windows";
import { createStateStore } from "../src/lib/state/core";
import { type CalendlyWebhookDeps, computeCalendlySignature, handleCalendlyWebhook } from "../src/lib/webhooks/calendly";
import type { Database } from "../src/types/database";
import type { DatabaseWithWave1, DatabaseWithWebhooks, MeetingRowShape } from "../src/types/database-extensions";
import type { LeadState } from "../src/types/enums";

// U8 DoD against Supabase (09 §U8): Calendly signature, persist-first, the
// booking stop, cancel / reschedule (both delivery orders) never restarting
// outreach, unmatched invitees, no-shows, replay, and the operator outcome
// script. handleCalendlyWebhook — the exact function the route calls — is
// driven with real signed Requests. Instantly is a stateful mock; a fetch
// guard fails on ANY non-Supabase call. Every row is a synthetic fixture
// tagged with TAG and removed afterwards; lead states move only through
// lib/state; BEFORE = AFTER on every table, meetings included.

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const raw = createServiceClient(url, key);
const db = raw as unknown as SupabaseClient<DatabaseWithWebhooks>;
const wave1 = raw as unknown as SupabaseClient<DatabaseWithWave1>;
const state = createStateStore(raw as SupabaseClient<Database>);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const STAMP = Date.now();
const TAG = `test-u8-${STAMP}`;
const NOW = new Date();
const TODAY = ledgerDate(NOW);
const SIGNING_KEY = `synthetic-u8-signing-key-${STAMP}-not-a-secret`;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const fixture = {
  accountIds: [] as string[],
  companyIds: [] as string[],
  leadIds: [] as string[],
  jobIds: [] as string[],
  eventIds: [] as string[],
};

const network: string[] = [];
const realFetch = globalThis.fetch;
function guardFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.startsWith(url!)) return realFetch(input, init); // Supabase itself
    network.push(target);
    throw new Error(`unexpected network call: ${target}`);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Stateful Instantly mock + deps
// ---------------------------------------------------------------------------

type MockLead = { id: string; email: string; campaign: string; present: boolean };
const inst = {
  leads: new Map<string, MockLead>(),
  calls: [] as Array<{ op: string; arg: string }>,
  alerts: [] as string[],
  transitions: 0,
  failNextTransition: false,
};
const ctx = (op: string, method: "GET" | "DELETE", path: string, status: number | null) => ({ op, method, path, status });
function calls(op: string, arg?: string): number {
  return inst.calls.filter((c) => c.op === op && (arg === undefined || c.arg === arg)).length;
}

const instantly = {
  async deleteLead(id: string) {
    inst.calls.push({ op: "deleteLead", arg: id });
    const lead = inst.leads.get(id);
    if (!lead?.present) throw new InstantlyPermanentError("mock 404", ctx("deleteLead", "DELETE", `/api/v2/leads/${id}`, 404), "validation");
    lead.present = false;
    return { id, status: 1, timestamp_created: NOW.toISOString() } as never;
  },
  async getLead(id: string) {
    inst.calls.push({ op: "getLead", arg: id });
    const lead = inst.leads.get(id);
    return lead?.present ? ({ id, email: lead.email, campaign: lead.campaign, status: 1, timestamp_created: NOW.toISOString() } as never) : null;
  },
  async findLeadInCampaign(campaignId: string, email: string) {
    inst.calls.push({ op: "findLeadInCampaign", arg: campaignId });
    const lead = [...inst.leads.values()].find((l) => l.present && l.campaign === campaignId && l.email === email);
    return lead ? ({ id: lead.id, email: lead.email, campaign: lead.campaign, status: 1, timestamp_created: NOW.toISOString() } as never) : null;
  },
  async pauseCampaign(id: string) {
    inst.calls.push({ op: "pauseCampaign", arg: id });
    return { id, name: "paused", status: 2, timestamp_created: NOW.toISOString() } as never;
  },
};

const transition: CalendlyWebhookDeps["transition"] = async (...args) => {
  inst.transitions += 1;
  if (inst.failNextTransition) {
    inst.failNextTransition = false;
    throw new Error("injected transition failure (replay test)");
  }
  return state.transition(...args);
};

function deps(over: Partial<CalendlyWebhookDeps> = {}): CalendlyWebhookDeps {
  return {
    db: wave1,
    signingKey: SIGNING_KEY,
    transition,
    instantly,
    alert: async (text) => {
      inst.alerts.push(text);
    },
    now: () => NOW,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PATH: Array<[LeadState, LeadState]> = [
  ["sourced", "enriching"],
  ["enriching", "qualifying"],
  ["qualifying", "qualified"],
  ["qualified", "verifying"],
  ["verifying", "drafting"],
  ["drafting", "pending_approval"],
  ["pending_approval", "approved"],
  ["approved", "queued"],
  ["queued", "sent"],
];

type Fx = { leadId: string; companyId: string; email: string; touches: Record<number, string>; providerLeadId?: string; enrollmentId?: string };

async function createAccount(): Promise<{ id: string; campaign: string }> {
  const campaign = `${TAG}.camp`;
  const { data, error } = await db
    .from("send_accounts")
    .insert({
      kind: "email",
      identifier: `u8-${STAMP}@zyndixhq.com`,
      domain: "zyndixhq.com",
      provider: "test",
      health: "ok",
      instantly_campaign_id: campaign,
      ramp_started_on: TODAY,
      signature_text: "Test\nZyndix, Vilnius\nzyndix.com",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture account: ${error?.message}`);
  fixture.accountIds.push(data.id);
  return { id: data.id, campaign };
}

/** A lead walked to `target` through lib/state (then optionally → hold/suppressed), with a 3-step sequence. */
async function lead(
  n: string,
  target: LeadState,
  opts: { then?: LeadState; email?: string; account?: { id: string; campaign: string } } = {},
): Promise<Fx> {
  const domain = `${n}.${TAG}.example.invalid`;
  const { data: company, error: companyError } = await db
    .from("companies")
    .insert({ name: `U8 Fixture ${n}`, domain, country: "LT", segment: "test" })
    .select("id")
    .single();
  if (companyError || !company) throw new Error(`fixture company: ${companyError?.message}`);
  fixture.companyIds.push(company.id);

  const email = opts.email ?? `lead@${domain}`;
  const { data: row, error: leadError } = await db
    .from("leads")
    .insert({
      company_id: company.id,
      first_name: "Test",
      last_name: `Lead ${n}`,
      email,
      email_status: "valid",
      email_verified_at: NOW.toISOString(),
      timezone: "Europe/Vilnius",
      state: "sourced",
    })
    .select("id")
    .single();
  if (leadError || !row) throw new Error(`fixture lead: ${leadError?.message}`);
  fixture.leadIds.push(row.id);
  for (const [from, to] of PATH) {
    if (from === target) break;
    await state.transition(row.id, from, to, "test_u8_fixture", { tag: TAG });
    if (to === target) break;
  }
  if (opts.then) await state.transition(row.id, target, opts.then, "test_u8_fixture", { tag: TAG });

  const sent = ["sent"].includes(target);
  const rows = [1, 2, 3].map((step) => ({
    lead_id: row.id,
    step_no: step,
    channel: "email",
    direction: "outbound",
    status: sent && step === 1 ? "sent" : "approved",
    body: `Step ${step} body`,
    approval_hash: `${TAG}.hash.${n}`,
    send_account_id: opts.account?.id ?? null,
    sent_at: sent && step === 1 ? new Date(NOW.getTime() - HOUR).toISOString() : null,
  }));
  const { data: touches, error: touchError } = await db.from("touches").insert(rows).select("id, step_no");
  if (touchError || !touches) throw new Error(`fixture touches: ${touchError?.message}`);
  const fx: Fx = { leadId: row.id, companyId: company.id, email, touches: Object.fromEntries(touches.map((t) => [t.step_no!, t.id])) };

  if (opts.account) {
    await db.from("leads").update({ send_account_id: opts.account.id }).eq("id", row.id);
    const providerLeadId = `${TAG}.pl.${n}`;
    const { data: enr, error: enrError } = await (raw as unknown as SupabaseClient<DatabaseWithWave1>)
      .from("instantly_enrollments")
      .insert({
        lead_id: row.id,
        send_account_id: opts.account.id,
        campaign_id: opts.account.campaign,
        provider_lead_id: providerLeadId,
        sequence_hash: `${TAG}.hash.${n}`,
        steps_total: 3,
        state: "active",
      })
      .select("id")
      .single();
    if (enrError || !enr) throw new Error(`fixture enrollment: ${enrError?.message}`);
    inst.leads.set(providerLeadId, { id: providerLeadId, email, campaign: opts.account.campaign, present: true });
    fx.providerLeadId = providerLeadId;
    fx.enrollmentId = enr.id;
  }
  return fx;
}

async function job(type: string, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await db
    .from("jobs")
    .insert({ type, payload: payload as never, state: "queued", run_after: new Date(NOW.getTime() + 30 * DAY).toISOString() })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture job: ${error?.message}`);
  fixture.jobIds.push(data.id);
  return data.id;
}

// ---------------------------------------------------------------------------
// Calendly payloads (field names from the OpenAPI WebhookPayload / InviteePayload)
// ---------------------------------------------------------------------------

const uri = (id: string) => `https://api.calendly.com/scheduled_events/${TAG}-ev-${id}/invitees/${TAG}-inv-${id}`;

type InviteeOpts = {
  id: string;
  email: string;
  start: Date;
  rescheduled?: boolean;
  old?: string | null;
  new?: string | null;
  canceled?: boolean;
  noShow?: string | null;
};

function invitee(o: InviteeOpts) {
  return {
    uri: uri(o.id),
    email: o.email,
    name: `Invitee ${o.id}`,
    first_name: null,
    last_name: null,
    status: o.canceled ? "canceled" : "active",
    timezone: "Europe/Vilnius",
    event: `https://api.calendly.com/scheduled_events/${TAG}-ev-${o.id}`,
    created_at: new Date(NOW.getTime() - 60_000).toISOString(),
    updated_at: new Date(NOW.getTime() - 60_000).toISOString(),
    rescheduled: o.rescheduled ?? false,
    old_invitee: o.old ?? null,
    new_invitee: o.new ?? null,
    cancel_url: `https://calendly.com/cancellations/${TAG}-${o.id}`,
    reschedule_url: `https://calendly.com/reschedulings/${TAG}-${o.id}`,
    cancellation: o.canceled
      ? { canceled_by: `Invitee ${o.id}`, reason: o.rescheduled ? null : "Something came up", canceler_type: "invitee", created_at: new Date(NOW.getTime() - 30_000).toISOString() }
      : undefined,
    no_show: o.noShow ? { uri: `https://api.calendly.com/invitee_no_shows/${TAG}-${o.noShow}`, created_at: new Date(NOW.getTime() - 10_000).toISOString() } : null,
    scheduled_event: {
      uri: `https://api.calendly.com/scheduled_events/${TAG}-ev-${o.id}`,
      name: "Zyndix intro call",
      status: o.canceled ? "canceled" : "active",
      start_time: o.start.toISOString(),
      end_time: new Date(o.start.getTime() + 30 * 60_000).toISOString(),
    },
  };
}

/** The fields a failing assertion needs, not the whole row. */
function brief(m: MeetingRowShape | null | undefined): string {
  if (!m) return "null";
  return JSON.stringify({ status: m.status, lead_id: m.lead_id, start_at: m.start_at, no_show_at: m.no_show_at, canceled_by: m.canceled_by, rescheduled_from: m.rescheduled_from, rescheduled_to: m.rescheduled_to });
}

function envelope(event: string, payload: unknown) {
  return { event, created_at: new Date(NOW.getTime() - 5_000).toISOString(), created_by: `https://api.calendly.com/users/${TAG}`, payload };
}

type PostOpts = { deps?: CalendlyWebhookDeps; header?: string | null; t?: number; sigKey?: string; rawText?: string };

async function post(body: unknown, opts: PostOpts = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = opts.rawText ?? JSON.stringify(body);
  const t = String(opts.t ?? Math.floor(NOW.getTime() / 1000));
  const header = opts.header !== undefined ? opts.header : `t=${t},v1=${computeCalendlySignature(opts.sigKey ?? SIGNING_KEY, t, text)}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (header !== null) headers["Calendly-Webhook-Signature"] = header;
  const req = new Request("http://localhost/api/webhooks/calendly", { method: "POST", headers, body: text });
  const res = await handleCalendlyWebhook(req, opts.deps ?? deps());
  const parsed = (await res.json()) as Record<string, unknown>;
  if (typeof parsed.eventId === "string") fixture.eventIds.push(parsed.eventId);
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function leadState(id: string): Promise<string | null> {
  const { data } = await db.from("leads").select("state").eq("id", id).single();
  return data?.state ?? null;
}
async function meeting(id: string): Promise<MeetingRowShape | null> {
  const { data } = await wave1.from("meetings").select("*").eq("external_id", uri(id)).maybeSingle();
  return data ?? null;
}
async function meetingsFor(leadId: string): Promise<MeetingRowShape[]> {
  const { data } = await wave1.from("meetings").select("*").eq("lead_id", leadId);
  return data ?? [];
}
async function eventsFor(leadId: string, event: string) {
  const { data } = await db.from("lead_events").select("detail").eq("lead_id", leadId).eq("event", event);
  return data ?? [];
}
async function jobState(id: string): Promise<string | undefined> {
  const { data } = await db.from("jobs").select("state").eq("id", id).single();
  return data?.state;
}
/** Queued jobs referencing the lead or any of its touches (any type). */
async function queuedJobsFor(f: Fx): Promise<number> {
  const byLead = await db.from("jobs").select("id", { count: "exact", head: true }).eq("state", "queued").eq("payload->>lead_id", f.leadId);
  const byTouch = await db.from("jobs").select("id", { count: "exact", head: true }).eq("state", "queued").in("payload->>touch_id", Object.values(f.touches));
  return (byLead.count ?? 0) + (byTouch.count ?? 0);
}
/** Every job (any state) referencing the lead or its touches. */
async function allJobsFor(f: Fx): Promise<number> {
  const byLead = await db.from("jobs").select("id", { count: "exact", head: true }).eq("payload->>lead_id", f.leadId);
  const byTouch = await db.from("jobs").select("id", { count: "exact", head: true }).in("payload->>touch_id", Object.values(f.touches));
  return (byLead.count ?? 0) + (byTouch.count ?? 0);
}
async function touchStatus(id: string): Promise<string | null> {
  const { data } = await db.from("touches").select("status").eq("id", id).single();
  return data?.status ?? null;
}
async function exceptionsForEvent(kind: string, eventId: unknown) {
  const { data } = await db.from("exceptions").select("status, lead_id, provider, detail").eq("kind", kind).eq("webhook_event_id", String(eventId));
  return data ?? [];
}
async function exceptionsForLead(kind: string, leadId: string) {
  const { data } = await db.from("exceptions").select("status, provider").eq("kind", kind).eq("lead_id", leadId);
  return data ?? [];
}
async function count(table: string): Promise<number> {
  const { count: n, error } = await (raw as unknown as SupabaseClient<DatabaseWithWave1>)
    .from(table as "leads")
    .select("*", { count: "exact", head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return n ?? 0;
}

// ---------------------------------------------------------------------------
// A — authentication: nothing is written unless the signature is valid
// ---------------------------------------------------------------------------

async function authCases(): Promise<void> {
  console.log("\n--- A: signature, zero rows on refusal ---");
  const body = envelope("invitee.created", invitee({ id: "auth", email: `lead@auth.${TAG}.example.invalid`, start: new Date(NOW.getTime() + DAY) }));
  const tables = ["webhook_events", "meetings", "exceptions", "leads", "lead_events", "jobs"];
  const before = await Promise.all(tables.map(count));
  const unset = await post(body, { deps: deps({ signingKey: undefined }) });
  const short = await post(body, { deps: deps({ signingKey: "too-short" }) });
  const missing = await post(body, { header: null });
  const bad = await post(body, { sigKey: "a-different-key-that-is-long-enough-000" });
  const garbage = await post(body, { header: "t=abc,v1=zz" });
  const stale = await post(body, { t: Math.floor((NOW.getTime() - 4 * 60_000) / 1000) });
  const future = await post(body, { t: Math.floor((NOW.getTime() + 4 * 60_000) / 1000) });
  const text = JSON.stringify(body);
  const t = String(Math.floor(NOW.getTime() / 1000));
  const tampered = await post(body, { header: `t=${t},v1=${computeCalendlySignature(SIGNING_KEY, t, text)}`, rawText: text.replace("auth", "auth2") });
  const badJson = await post(null, { rawText: "{not json" });
  const notObject = await post(null, { rawText: "[1,2]" });
  const after = await Promise.all(tables.map(count));

  assert("A: signing key unset → 500", unset.status === 500, String(unset.status));
  assert("A: signing key shorter than 32 chars → 500 (treated as unset)", short.status === 500, String(short.status));
  assert("A: no signature header → 401", missing.status === 401, String(missing.status));
  assert("A: signed with the wrong key → 401", bad.status === 401, String(bad.status));
  assert("A: malformed header → 401", garbage.status === 401, String(garbage.status));
  assert("A: stale t (4 min old) → 401", stale.status === 401, String(stale.status));
  assert("A: t 4 min in the future → 401", future.status === 401, String(future.status));
  assert("A: body changed after signing → 401", tampered.status === 401, String(tampered.status));
  assert("A: valid signature, invalid JSON → 400; JSON array → 400", badJson.status === 400 && notObject.status === 400, `${badJson.status}/${notObject.status}`);
  assert(
    "A: ZERO rows written by any refused request (webhook_events, meetings, exceptions, leads, lead_events, jobs)",
    tables.every((_, i) => before[i] === after[i]),
    tables.map((tb, i) => `${tb} ${before[i]}→${after[i]}`).join(", "),
  );
}

// ---------------------------------------------------------------------------
// B — a booking stops outreach; a cancellation never restarts it
// ---------------------------------------------------------------------------

async function bookingCases(): Promise<void> {
  console.log("\n--- B1: invitee.created on an enrolled, sent lead ---");
  const account = await createAccount();
  const f = await lead("b1", "sent", { account });
  const sendJob = await job("send.email", { touch_id: f.touches[2], lead_id: f.leadId });
  const stageJob = await job(`${TAG}.stage`, { lead_id: f.leadId });
  const touchJob = await job(`${TAG}.touch`, { touch_id: f.touches[3] });
  const checkJob = await job("send.recipient_check", { touch_id: f.touches[1], lead_id: f.leadId });
  const start = new Date(NOW.getTime() + 2 * DAY);
  const body = envelope("invitee.created", invitee({ id: "b1", email: f.email.toUpperCase(), start }));
  const res = await post(body);
  const m = await meeting("b1");
  assert("B1: 200 processed meeting_booked", res.status === 200 && res.body.kind === "processed" && res.body.action === "meeting_booked", JSON.stringify(res.body));
  assert("B1: lead sent → meeting_booked (email matched case-insensitively)", (await leadState(f.leadId)) === "meeting_booked");
  const [s1, s2, s3, s4] = await Promise.all([jobState(sendJob), jobState(stageJob), jobState(touchJob), jobState(checkJob)]);
  assert("B1: all queued jobs for the lead cancelled (send.email, stage-by-lead, job-by-touch)", s1 === "cancelled" && s2 === "cancelled" && s3 === "cancelled", `${s1}/${s2}/${s3}`);
  assert("B1: send.recipient_check kept queued (an email that left is still checked)", s4 === "queued", s4);
  const rows = await meetingsFor(f.leadId);
  assert(
    "B1: exactly one meetings row: scheduled, lead + company linked, start_at, external_id = invitee uri, webhook_event_id",
    rows.length === 1 && m?.status === "scheduled" && m.company_id === f.companyId && Date.parse(m.start_at!) === start.getTime() &&
      m.external_id === uri("b1") && m.webhook_event_id === res.body.eventId && m.invitee_email === f.email,
    brief(m),
  );
  assert("B1: Instantly DELETE ×1 for the enrolled lead (mock)", calls("deleteLead", f.providerLeadId) === 1, String(calls("deleteLead", f.providerLeadId)));
  const { data: enr } = await wave1.from("instantly_enrollments").select("state, stop_reason").eq("id", f.enrollmentId!).single();
  assert("B1: enrollment removed, stop_reason meeting_booked", enr?.state === "removed" && enr.stop_reason === "meeting_booked", JSON.stringify(enr));
  assert("B1: unsent follow-ups 2 and 3 killed", (await touchStatus(f.touches[2]!)) === "killed" && (await touchStatus(f.touches[3]!)) === "killed");
  const prep = await eventsFor(f.leadId, "meeting_prep_due");
  assert("B1: one meeting-prep task (lead_event meeting_prep_due) for this meeting", prep.length === 1 && (prep[0]!.detail as Record<string, unknown>).meeting_id === m?.id, JSON.stringify(prep));
  assert("B1: Telegram alert sent (mock)", inst.alerts.some((a) => a.includes("Meeting booked") && a.includes(f.leadId)));

  console.log("\n--- B2: duplicate delivery ---");
  const alertsBefore = inst.alerts.length;
  const transitionsBefore = inst.transitions;
  const dup = await post(body);
  assert("B2: same external_id → 200 duplicate", dup.status === 200 && dup.body.kind === "duplicate", JSON.stringify(dup.body));
  assert(
    "B2: no-op — still one meeting, one prep task, DELETE still ×1, no transition, no alert",
    (await meetingsFor(f.leadId)).length === 1 && (await eventsFor(f.leadId, "meeting_prep_due")).length === 1 &&
      calls("deleteLead", f.providerLeadId) === 1 && inst.transitions === transitionsBefore && inst.alerts.length === alertsBefore,
  );

  console.log("\n--- B3: invitee.canceled (not a reschedule) ---");
  const queuedBefore = await queuedJobsFor(f);
  const allBefore = await allJobsFor(f);
  const cancel = await post(envelope("invitee.canceled", invitee({ id: "b1", email: f.email, start, canceled: true })));
  const mc = await meeting("b1");
  const queuedAfter = await queuedJobsFor(f);
  const allAfter = await allJobsFor(f);
  assert("B3: 200 processed canceled", cancel.status === 200 && cancel.body.action === "canceled", JSON.stringify(cancel.body));
  assert(
    "B3: meeting status canceled with canceled_at / canceled_by / canceler_type / reason",
    mc?.status === "canceled" && Boolean(mc.canceled_at) && mc.canceled_by === "Invitee b1" && mc.canceler_type === "invitee" && mc.cancel_reason === "Something came up",
    brief(mc),
  );
  assert("B3: ZERO queued send jobs created (no auto-restart), by count", queuedAfter === queuedBefore && allAfter === allBefore, `queued ${queuedBefore}→${queuedAfter}, all ${allBefore}→${allAfter}`);
  assert("B3: lead stays meeting_booked (never back to a sending state)", (await leadState(f.leadId)) === "meeting_booked");
  assert("B3: lead_event meeting_canceled with outreach_restarted=false + alert", (await eventsFor(f.leadId, "meeting_canceled")).some((e) => (e.detail as Record<string, unknown>).outreach_restarted === false) && inst.alerts.some((a) => a.includes("NOT restarted")));
}

// ---------------------------------------------------------------------------
// C — reschedules in both delivery orders
// ---------------------------------------------------------------------------

async function rescheduleCase(label: string, order: "canceled_first" | "created_first"): Promise<void> {
  console.log(`\n--- ${label}: reschedule, ${order} ---`);
  const f = await lead(label.toLowerCase(), "approved");
  const s1 = new Date(NOW.getTime() + 3 * DAY);
  const s2 = new Date(NOW.getTime() + 5 * DAY);
  const oldId = `${label}-old`;
  const newId = `${label}-new`;
  const booked = await post(envelope("invitee.created", invitee({ id: oldId, email: f.email, start: s1 })));
  assert(`${label}: original booking → approved → meeting_booked`, booked.body.action === "meeting_booked" && (await leadState(f.leadId)) === "meeting_booked", JSON.stringify(booked.body));
  const transitionsBefore = inst.transitions;
  const jobsBefore = await allJobsFor(f);
  const canceled = envelope("invitee.canceled", invitee({ id: oldId, email: f.email, start: s1, canceled: true, rescheduled: true, new: uri(newId) }));
  const created = envelope("invitee.created", invitee({ id: newId, email: f.email, start: s2, old: uri(oldId) }));
  const first = await post(order === "canceled_first" ? canceled : created);
  const second = await post(order === "canceled_first" ? created : canceled);
  const oldRow = await meeting(oldId);
  const newRow = await meeting(newId);
  assert(`${label}: both deliveries 200 processed`, first.status === 200 && second.status === 200 && first.body.kind === "processed" && second.body.kind === "processed", `${JSON.stringify(first.body)} ${JSON.stringify(second.body)}`);
  assert(
    `${label}: old row rescheduled → new invitee; new row scheduled ← old invitee`,
    oldRow?.status === "rescheduled" && oldRow.rescheduled_to === uri(newId) && newRow?.status === "scheduled" && newRow.rescheduled_from === uri(oldId),
    `old=${oldRow?.status}/${oldRow?.rescheduled_to} new=${newRow?.status}/${newRow?.rescheduled_from}`,
  );
  assert(`${label}: the live meeting's start_at is the new time`, Date.parse(newRow?.start_at ?? "") === s2.getTime() && Date.parse(oldRow?.start_at ?? "") === s1.getTime(), `${newRow?.start_at}`);
  assert(`${label}: no state change (still meeting_booked, zero transitions)`, (await leadState(f.leadId)) === "meeting_booked" && inst.transitions === transitionsBefore, `transitions +${inst.transitions - transitionsBefore}`);
  assert(`${label}: zero jobs created`, (await allJobsFor(f)) === jobsBefore);
  assert(`${label}: one meeting_rescheduled event, no second prep task, no reschedule_unlinked exception`,
    (await eventsFor(f.leadId, "meeting_rescheduled")).length === 1 && (await eventsFor(f.leadId, "meeting_prep_due")).length === 1 &&
      (await exceptionsForLead("meeting_reschedule_unlinked", f.leadId)).length === 0);
  assert(`${label}: both rows linked to the lead`, oldRow?.lead_id === f.leadId && newRow?.lead_id === f.leadId);
}

// ---------------------------------------------------------------------------
// D — matching, state rules, reordering, replay, no-shows, other events
// ---------------------------------------------------------------------------

async function otherCases(): Promise<void> {
  console.log("\n--- D1: unknown email ---");
  const leadsBefore = await count("leads");
  const leadEventsBefore = await count("lead_events");
  const transitionsBefore = inst.transitions;
  const unknownEmail = `nobody@unknown.${TAG}.example.invalid`;
  const unk = await post(envelope("invitee.created", invitee({ id: "d1", email: unknownEmail, start: new Date(NOW.getTime() + DAY) })));
  const ex = await exceptionsForEvent("calendly_unmatched_invitee", unk.body.eventId);
  const m = await meeting("d1");
  assert("D1: 200 exception calendly_unmatched_invitee", unk.status === 200 && unk.body.exception === "calendly_unmatched_invitee", JSON.stringify(unk.body));
  assert("D1: exactly one exception row, provider calendly, escalated", ex.length === 1 && ex[0]!.provider === "calendly" && ex[0]!.status === "escalated", JSON.stringify(ex));
  assert(
    "D1: zero lead mutations (leads and lead_events counts unchanged, zero transitions)",
    (await count("leads")) === leadsBefore && (await count("lead_events")) === leadEventsBefore && inst.transitions === transitionsBefore,
  );
  assert("D1: the meeting is still stored, lead_id null (decision: kept for the pipeline and later linking)", m?.lead_id === null && m.status === "scheduled", JSON.stringify(m));
  const unkCancel = await post(envelope("invitee.canceled", invitee({ id: "d1", email: unknownEmail, start: new Date(NOW.getTime() + DAY), canceled: true })));
  assert(
    "D1: its cancellation updates the row and raises no second exception",
    (await meeting("d1"))?.status === "canceled" && (await exceptionsForEvent("calendly_unmatched_invitee", unkCancel.body.eventId)).length === 0,
  );

  console.log("\n--- D2: canceled delivered before its invitee.created ---");
  const f2 = await lead("d2", "sent");
  const s = new Date(NOW.getTime() + DAY);
  const jobsBefore2 = await allJobsFor(f2);
  const c2 = await post(envelope("invitee.canceled", invitee({ id: "d2", email: f2.email, start: s, canceled: true })));
  const afterCancel = await leadState(f2.leadId);
  const cr2 = await post(envelope("invitee.created", invitee({ id: "d2", email: f2.email, start: s })));
  const m2 = await meeting("d2");
  assert("D2: cancel-first → row canceled, booking stop applied (lead sent → meeting_booked)", c2.body.action === "canceled" && afterCancel === "meeting_booked", `${JSON.stringify(c2.body)} ${afterCancel}`);
  assert("D2: late invitee.created never revives the status (stays canceled)", cr2.status === 200 && m2?.status === "canceled", `${m2?.status}`);
  assert("D2: no prep task for a canceled meeting; zero jobs created", (await eventsFor(f2.leadId, "meeting_prep_due")).length === 0 && (await allJobsFor(f2)) === jobsBefore2);

  console.log("\n--- D3: state rules ---");
  const q = await lead("d3q", "qualified");
  const rq = await post(envelope("invitee.created", invitee({ id: "d3q", email: q.email, start: new Date(NOW.getTime() + DAY) })));
  const exq = await exceptionsForLead("booking_unexpected_state", q.leadId);
  assert(
    "D3: qualified (no edge) → booking_unexpected_state escalated, lead → manual_hold, meeting still recorded",
    rq.body.action === "booking_unexpected_state" && exq.length === 1 && exq[0]!.status === "escalated" && (await leadState(q.leadId)) === "manual_hold" && (await meeting("d3q"))?.lead_id === q.leadId,
    JSON.stringify(rq.body),
  );
  const sup = await lead("d3s", "sent", { then: "suppressed" });
  const tBefore = inst.transitions;
  const rs = await post(envelope("invitee.created", invitee({ id: "d3s", email: sup.email, start: new Date(NOW.getTime() + DAY) })));
  assert(
    "D3: suppressed → recorded only, no transition, meeting recorded",
    rs.body.action === "recorded_suppressed" && (await leadState(sup.leadId)) === "suppressed" && inst.transitions === tBefore && (await meeting("d3s"))?.lead_id === sup.leadId,
    JSON.stringify(rs.body),
  );
  const hold = await lead("d3h", "sent", { then: "manual_hold" });
  const past = new Date(NOW.getTime() - 2 * HOUR);
  const rh = await post(envelope("invitee.created", invitee({ id: "d3h", email: hold.email, start: past })));
  assert("D3: manual_hold → meeting_booked (the edge exists)", rh.body.action === "meeting_booked" && (await leadState(hold.leadId)) === "meeting_booked", JSON.stringify(rh.body));
  const again = await post(envelope("invitee.created", invitee({ id: "d3h2", email: hold.email, start: new Date(NOW.getTime() + 4 * DAY) })));
  assert("D3: a second booking for a meeting_booked lead → already_booked, a second meeting row", again.body.action === "already_booked" && (await meetingsFor(hold.leadId)).length === 2, JSON.stringify(again.body));

  console.log("\n--- D4: two leads share the email ---");
  const shared = `shared@d4.${TAG}.example.invalid`;
  const other = await lead("d4a", "approved", { email: shared });
  const primary = await lead("d4b", "sent", { email: shared });
  const r4 = await post(envelope("invitee.created", invitee({ id: "d4", email: shared, start: new Date(NOW.getTime() + DAY) })));
  const m4 = await meeting("d4");
  assert("D4: meeting linked to the contacted lead (sent ranks before approved)", r4.body.leadId === primary.leadId && m4?.lead_id === primary.leadId, JSON.stringify(r4.body));
  assert(
    "D4: both leads stopped → meeting_booked; the prep task only on the primary",
    (await leadState(primary.leadId)) === "meeting_booked" && (await leadState(other.leadId)) === "meeting_booked" &&
      (await eventsFor(primary.leadId, "meeting_prep_due")).length === 1 && (await eventsFor(other.leadId, "meeting_prep_due")).length === 0,
  );

  console.log("\n--- D5: a failed attempt is replayed idempotently ---");
  const f5 = await lead("d5", "sent");
  const b5 = envelope("invitee.created", invitee({ id: "d5", email: f5.email, start: new Date(NOW.getTime() + DAY) }));
  inst.failNextTransition = true;
  const fail = await post(b5);
  const { data: ev5 } = await db.from("webhook_events").select("id, processed, processing_error").eq("provider", "calendly").eq("external_id", `invitee.created:${uri("d5")}`).single();
  if (ev5) fixture.eventIds.push(ev5.id);
  assert("D5: processing error → 500, event stored unprocessed with processing_error", fail.status === 500 && ev5?.processed === false && Boolean(ev5.processing_error), JSON.stringify(ev5));
  const replay = await post(b5);
  assert(
    "D5: redelivery replays → meeting_booked, one meetings row, one prep task, event processed",
    replay.status === 200 && replay.body.action === "meeting_booked" && (await leadState(f5.leadId)) === "meeting_booked" &&
      (await meetingsFor(f5.leadId)).length === 1 && (await eventsFor(f5.leadId, "meeting_prep_due")).length === 1,
    JSON.stringify(replay.body),
  );

  console.log("\n--- D6: no-shows ---");
  const f6 = await lead("d6", "sent");
  const start6 = new Date(NOW.getTime() - 3 * HOUR);
  await post(envelope("invitee.created", invitee({ id: "d6", email: f6.email, start: start6 })));
  const tBefore6 = inst.transitions;
  const ns = await post(envelope("invitee_no_show.created", invitee({ id: "d6", email: f6.email, start: start6, noShow: "ns1" })));
  const afterNs = await meeting("d6");
  assert("D6: invitee_no_show.created → no_show + no_show_at", ns.body.action === "no_show" && afterNs?.status === "no_show" && Boolean(afterNs.no_show_at), JSON.stringify(afterNs));
  const nsDel = await post(envelope("invitee_no_show.deleted", invitee({ id: "d6", email: f6.email, start: start6, noShow: "ns1" })));
  const afterDel = await meeting("d6");
  assert("D6: invitee_no_show.deleted → back to scheduled, no_show_at cleared", nsDel.status === 200 && afterDel?.status === "scheduled" && afterDel.no_show_at === null, JSON.stringify(afterDel));
  assert("D6: no-show events change no lead state", inst.transitions === tBefore6 && (await leadState(f6.leadId)) === "meeting_booked");
  const canceledRow = await post(envelope("invitee_no_show.deleted", invitee({ id: "b1", email: "x@b1.example.invalid", start: NOW, noShow: "ns-b1" })));
  assert("D6: .deleted on a non-no_show meeting leaves it alone", canceledRow.status === 200 && (await meeting("b1"))?.status === "canceled");

  console.log("\n--- D7: other event types, invalid payloads ---");
  const evBefore = await count("webhook_events");
  const other7 = await post({ event: "event_type.created", created_at: NOW.toISOString(), created_by: `https://api.calendly.com/users/${TAG}`, payload: { uri: `https://api.calendly.com/event_types/${TAG}` } });
  assert("D7: event_type.created → 200 recorded_only, stored", other7.status === 200 && other7.body.action === "recorded_only" && (await count("webhook_events")) === evBefore + 1, JSON.stringify(other7.body));
  const invalid = await post({ event: "invitee.created", created_at: NOW.toISOString(), payload: { uri: uri("d7"), email: "not-an-email" } });
  assert("D7: invitee.created without scheduled_event → exception invalid_payload (stored, 200)", invalid.status === 200 && invalid.body.exception === "invalid_payload" && (await exceptionsForEvent("invalid_payload", invalid.body.eventId)).length === 1, JSON.stringify(invalid.body));

  console.log("\n--- D8: scripts/meeting-outcome.ts on a synthetic meeting ---");
  const held = await meeting("d3h");
  const run = (...args: string[]) =>
    spawnSync(resolve(process.cwd(), "node_modules/.bin/tsx"), ["scripts/meeting-outcome.ts", ...args], { encoding: "utf-8", env: process.env });
  const dry = run("--meeting", held!.id, "--held");
  const afterDry = await meeting("d3h");
  assert("D8: dry run (default) prints the plan and writes nothing", dry.status === 0 && dry.stdout.includes("Dry run") && afterDry?.status === "scheduled" && afterDry.outcome_recorded_by === null, dry.stdout + dry.stderr);
  const applied = run("--meeting", held!.id, "--held", "--apply", "--by", `test:${TAG}`);
  const afterApply = await meeting("d3h");
  assert(
    "D8: --apply → held, outcome_recorded_by/at, lead_event meeting_held; lead state unchanged",
    applied.status === 0 && afterApply?.status === "held" && afterApply.outcome_recorded_by === `test:${TAG}` && Boolean(afterApply.outcome_recorded_at) &&
      (await eventsFor(hold.leadId, "meeting_held")).length === 1 && (await leadState(hold.leadId)) === "meeting_booked",
    applied.stdout + applied.stderr,
  );
  const future = await meeting("d3h2");
  const refused = run("--meeting", future!.id, "--no-show", "--apply");
  assert("D8: a meeting that has not started is refused (exit 1, unchanged)", refused.status === 1 && (await meeting("d3h2"))?.status === "scheduled", refused.stderr);
  const bad = run("--meeting", "nope", "--held");
  assert("D8: bad arguments → exit 2", bad.status === 2, String(bad.status));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const TABLES = [
  "leads",
  "touches",
  "lead_events",
  "jobs",
  "companies",
  "send_accounts",
  "webhook_events",
  "exceptions",
  "instantly_enrollments",
  "meetings",
] as const;

async function cleanup(): Promise<void> {
  const del = async (label: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await run();
    if (error) console.error(`cleanup ${label}: ${error.message}`);
  };
  const { data: tagged } = await db.from("webhook_events").select("id").eq("provider", "calendly").like("external_id", `%${TAG}%`);
  const { data: taggedPayload } = await db.from("webhook_events").select("id").eq("provider", "calendly").like("payload->>created_by", `%${TAG}%`);
  const eventIds = [...new Set([...fixture.eventIds, ...(tagged ?? []).map((r) => r.id), ...(taggedPayload ?? []).map((r) => r.id)])];
  await del("meetings(tag)", () => wave1.from("meetings").delete().like("external_id", `%${TAG}%`));
  if (fixture.leadIds.length) await del("meetings(lead)", () => wave1.from("meetings").delete().in("lead_id", fixture.leadIds));
  if (eventIds.length) await del("exceptions(event)", () => db.from("exceptions").delete().in("webhook_event_id", eventIds));
  if (fixture.leadIds.length) await del("exceptions(lead)", () => db.from("exceptions").delete().in("lead_id", fixture.leadIds));
  if (eventIds.length) await del("webhook_events", () => db.from("webhook_events").delete().in("id", eventIds));
  if (fixture.jobIds.length) await del("jobs", () => db.from("jobs").delete().in("id", fixture.jobIds));
  if (fixture.leadIds.length) {
    await del("instantly_enrollments", () => wave1.from("instantly_enrollments").delete().in("lead_id", fixture.leadIds));
    await del("touches", () => db.from("touches").delete().in("lead_id", fixture.leadIds));
    await del("lead_events", () => db.from("lead_events").delete().in("lead_id", fixture.leadIds));
    await del("leads", () => db.from("leads").delete().in("id", fixture.leadIds));
  }
  if (fixture.companyIds.length) await del("companies", () => db.from("companies").delete().in("id", fixture.companyIds));
  if (fixture.accountIds.length) await del("send_accounts", () => db.from("send_accounts").delete().in("id", fixture.accountIds));
}

async function main(): Promise<void> {
  console.log(`\n=== test-u8-calendly (tag=${TAG}) ===`);
  const before: Record<string, number> = {};
  for (const t of TABLES) before[t] = await count(t);
  console.log(`BEFORE  ${TABLES.map((t) => `${t}=${before[t]}`).join(" ")}`);
  guardFetch();
  try {
    await authCases();
    await bookingCases();
    await rescheduleCase("C1", "canceled_first");
    await rescheduleCase("C2", "created_first");
    await otherCases();
    assert("no network call escaped the mocks (0 Calendly, 0 Instantly, 0 Telegram, 0 Anthropic)", network.length === 0, network.join(", "));
    assert("Instantly mock: only stop operations were called (no pause)", inst.calls.every((c) => ["deleteLead", "getLead", "findLeadInCampaign"].includes(c.op)), JSON.stringify(inst.calls.map((c) => c.op)));
  } catch (error) {
    assert("no unexpected exception", false, error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error));
  } finally {
    globalThis.fetch = realFetch;
    await cleanup();
    console.log("\nCleanup: fixture rows removed.");
  }
  const after: Record<string, number> = {};
  for (const t of TABLES) after[t] = await count(t);
  console.log(`AFTER   ${TABLES.map((t) => `${t}=${after[t]}`).join(" ")}`);
  for (const t of TABLES) assert(`${t} count unchanged`, before[t] === after[t], `${before[t]} → ${after[t]}`);

  const failed = results.filter((r) => !r.pass);
  console.log(failed.length ? `\n${failed.length} of ${results.length} check(s) FAILED.` : `\nAll ${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
