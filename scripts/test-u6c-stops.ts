import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import {
  InstantlyPermanentError,
  InstantlyUncertainOutcomeError,
} from "../src/lib/integrations/instantly";
import type { ReconcileDeps } from "../src/lib/reconcile/core";
import { runInstantlyLeadSweep } from "../src/lib/reconcile/core";
import { ledgerDate } from "../src/lib/scheduler/windows";
import { type RecipientCheckDeps, runRecipientCheck } from "../src/lib/sending/recipient-check";
import { holdAndStop, pauseSender, stopSequence } from "../src/lib/sending/stop";
import { capacity_defaults } from "../src/lib/settings/seed-content";
import { createStateStore } from "../src/lib/state/core";
import { type InstantlyWebhookDeps, processInstantlyEvent } from "../src/lib/webhooks/instantly";
import type { Database } from "../src/types/database";
import type { DatabaseWithEnrollments, DatabaseWithWebhooks } from "../src/types/database-extensions";
import type { LeadState } from "../src/types/enums";

// U6c S21 DoD against Supabase (09 §U6c): follow-up tracking (T1–T4), the
// post-send recipient check (T3), stopSequence and its callers (S1–S9) and
// the reconcile lead sweep (R1–R2). Instantly is a stateful mock; a fetch
// guard fails on ANY network call, so no model or provider call can escape.
// Every row is a synthetic fixture tagged with TAG and removed afterwards;
// lead states move only through lib/state; BEFORE = AFTER on every table.

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const raw = createServiceClient(url, key);
const db = raw as unknown as SupabaseClient<DatabaseWithWebhooks>;
const enrollDb = raw as unknown as SupabaseClient<DatabaseWithEnrollments>;
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
const TAG = `test.u6c.${STAMP}`;
const NOW = new Date();
const TODAY = ledgerDate(NOW);

const fixture = {
  accountIds: [] as string[],
  companyIds: [] as string[],
  leadIds: [] as string[],
  suppressionEmails: [] as string[],
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
// Stateful Instantly mock
// ---------------------------------------------------------------------------

type MockLead = { id: string; email: string; campaign: string; status: number; present: boolean };
type DeleteBehaviour = "ok" | "500" | "timeout_applied";
type MockEmail = { to: string; cc?: string | null; bcc?: string | null };

const inst = {
  leads: new Map<string, MockLead>(),
  deleteBehaviour: new Map<string, DeleteBehaviour[]>(),
  emails: new Map<string, MockEmail>(),
  calls: [] as Array<{ op: string; arg: string }>,
  alerts: [] as string[],
  enqueued: [] as Array<{ type: string; payload: Record<string, unknown>; idempotencyKey?: string; runAfter?: string }>,
};

const ctx = (op: string, method: "GET" | "DELETE", path: string, status: number | null) => ({ op, method, path, status });

function calls(op: string, arg?: string): number {
  return inst.calls.filter((c) => c.op === op && (arg === undefined || c.arg === arg)).length;
}

const instantly = {
  async deleteLead(id: string) {
    inst.calls.push({ op: "deleteLead", arg: id });
    const behaviour = inst.deleteBehaviour.get(id)?.shift() ?? "ok";
    const lead = inst.leads.get(id);
    const path = `/api/v2/leads/${id}`;
    if (behaviour === "500") {
      throw new InstantlyUncertainOutcomeError("mock DELETE 500 — may have been applied", ctx("deleteLead", "DELETE", path, 500), "server_error", { leadId: id });
    }
    if (behaviour === "timeout_applied") {
      if (lead) lead.present = false;
      throw new InstantlyUncertainOutcomeError("mock DELETE timed out after dispatch", ctx("deleteLead", "DELETE", path, null), "timeout_after_dispatch", { leadId: id });
    }
    if (!lead?.present) throw new InstantlyPermanentError("mock 404", ctx("deleteLead", "DELETE", path, 404), "validation");
    lead.present = false;
    return { id, status: lead.status, timestamp_created: NOW.toISOString() } as never;
  },
  async getLead(id: string) {
    inst.calls.push({ op: "getLead", arg: id });
    const lead = inst.leads.get(id);
    return lead?.present ? ({ id, email: lead.email, campaign: lead.campaign, status: lead.status, timestamp_created: NOW.toISOString() } as never) : null;
  },
  async findLeadInCampaign(campaignId: string, email: string) {
    inst.calls.push({ op: "findLeadInCampaign", arg: campaignId });
    const lead = [...inst.leads.values()].find((l) => l.present && l.campaign === campaignId && l.email === email);
    return lead ? ({ id: lead.id, email: lead.email, campaign: lead.campaign, status: lead.status, timestamp_created: NOW.toISOString() } as never) : null;
  },
  async listCampaignLeads(campaignId: string) {
    inst.calls.push({ op: "listCampaignLeads", arg: campaignId });
    const items = [...inst.leads.values()]
      .filter((l) => l.present && l.campaign === campaignId)
      .map((l) => ({ id: l.id, email: l.email, campaign: l.campaign, status: l.status, timestamp_created: NOW.toISOString() }));
    return { items, next_starting_after: null } as never;
  },
  async getEmail(id: string) {
    inst.calls.push({ op: "getEmail", arg: id });
    const email = inst.emails.get(id);
    if (!email) throw new InstantlyPermanentError("mock 404", ctx("getEmail", "GET", `/api/v2/emails/${id}`, 404), "validation");
    return {
      id,
      timestamp_created: NOW.toISOString(),
      message_id: `<${id}@mock>`,
      subject: "Re: fixture",
      eaccount: "mock",
      to_address_email_list: email.to,
      cc_address_email_list: email.cc ?? null,
      bcc_address_email_list: email.bcc ?? null,
    } as never;
  },
  async pauseCampaign(id: string) {
    inst.calls.push({ op: "pauseCampaign", arg: id });
    return { id, name: "paused", status: 2, timestamp_created: NOW.toISOString() } as never;
  },
  async addBlockListEntry(value: string) {
    inst.calls.push({ op: "addBlockListEntry", arg: value });
    return { id: `${TAG}.bl`, bl_value: value, is_domain: false } as never;
  },
  async listEmails() {
    inst.calls.push({ op: "listEmails", arg: "" });
    return { items: [], next_starting_after: null } as never;
  },
};

const queue = {
  enqueue: async (input: { type: string; payload?: unknown; idempotencyKey?: string; runAfter?: string }) => {
    inst.enqueued.push({ type: input.type, payload: input.payload as Record<string, unknown>, idempotencyKey: input.idempotencyKey, runAfter: input.runAfter });
    return { job: { id: `${TAG}.job` }, deduped: false } as never;
  },
};

const getActiveSetting = async (k: string) => {
  if (k !== "capacity_defaults") throw new Error(`unexpected setting ${k}`);
  return { version: 1, value: capacity_defaults };
};
const alert = async (text: string) => {
  inst.alerts.push(text);
};

function webhookDeps(): InstantlyWebhookDeps {
  return { db, secret: undefined, transition: state.transition, instantly, queue, getActiveSetting, alert, now: () => NOW };
}
function stopDeps() {
  return { db, instantly, transition: state.transition, alert, now: () => NOW };
}
function checkDeps(): RecipientCheckDeps {
  return { db, instantly, transition: state.transition, alert, now: () => NOW };
}
function reconcileDeps(): ReconcileDeps {
  return { db, instantly, queue, transition: state.transition, getActiveSetting, alert, now: () => NOW };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Account = { id: string; identifier: string; campaign: string };
type Enrolled = { leadId: string; email: string; providerLeadId: string; touches: Record<number, string>; enrollmentId: string; hash: string };

async function createAccount(name: string): Promise<Account> {
  const identifier = `u6c-${STAMP}-${name}@zyndixhq.com`;
  const campaign = `${TAG}.camp-${name}`;
  const { data, error } = await db
    .from("send_accounts")
    .insert({
      kind: "email",
      identifier,
      domain: "zyndixhq.com",
      provider: "test",
      health: "ok",
      instantly_campaign_id: campaign,
      ramp_started_on: TODAY,
      signature_text: `Test ${name}\nZyndix, Vilnius\nzyndix.com`,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture account: ${error?.message}`);
  fixture.accountIds.push(data.id);
  return { id: data.id, identifier, campaign };
}

const PATH_TO_SENT: Array<[LeadState, LeadState]> = [
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

/** A lead walked to `sent` through lib/state, with a 3-step approved sequence, step 1 out, and a live enrollment. */
async function enrolledLead(n: string, account: Account, opts: { enroll?: boolean } = {}): Promise<Enrolled> {
  const domain = `${n}.${TAG}.example.invalid`;
  const { data: company, error: companyError } = await db
    .from("companies")
    .insert({ name: `U6c Fixture ${n}`, domain, country: "LT", segment: "test" })
    .select("id")
    .single();
  if (companyError || !company) throw new Error(`fixture company: ${companyError?.message}`);
  fixture.companyIds.push(company.id);

  const email = `lead@${domain}`;
  const { data: lead, error: leadError } = await db
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
  if (leadError || !lead) throw new Error(`fixture lead: ${leadError?.message}`);
  fixture.leadIds.push(lead.id);
  for (const [from, to] of PATH_TO_SENT) await state.transition(lead.id, from, to, "test_u6c_fixture", { tag: TAG });
  const { error: bindError } = await db.from("leads").update({ send_account_id: account.id }).eq("id", lead.id);
  if (bindError) throw new Error(`fixture bind: ${bindError.message}`);

  const hash = `${TAG}.hash.${n}`;
  const rows = [1, 2, 3].map((step) => ({
    lead_id: lead.id,
    step_no: step,
    channel: "email",
    direction: "outbound",
    status: step === 1 ? "sent" : "approved",
    subject: step === 1 ? "Your contact page" : null,
    body: `Step ${step} body`,
    approval_hash: hash,
    send_account_id: account.id,
    sent_at: step === 1 ? new Date(NOW.getTime() - 3_600_000).toISOString() : null,
  }));
  const { data: touches, error: touchError } = await db.from("touches").insert(rows).select("id, step_no");
  if (touchError || !touches) throw new Error(`fixture touches: ${touchError?.message}`);
  const byStep = Object.fromEntries(touches.map((t) => [t.step_no!, t.id]));

  const providerLeadId = `${TAG}.pl.${n}`;
  let enrollmentId = "";
  if (opts.enroll !== false) {
    const { data: enr, error: enrError } = await enrollDb
      .from("instantly_enrollments")
      .insert({
        lead_id: lead.id,
        send_account_id: account.id,
        campaign_id: account.campaign,
        provider_lead_id: providerLeadId,
        sequence_hash: hash,
        steps_total: 3,
        state: "active",
      })
      .select("id")
      .single();
    if (enrError || !enr) throw new Error(`fixture enrollment: ${enrError?.message}`);
    enrollmentId = enr.id;
    inst.leads.set(providerLeadId, { id: providerLeadId, email, campaign: account.campaign, status: 1, present: true });
  }
  return { leadId: lead.id, email, providerLeadId, touches: byStep, enrollmentId, hash };
}

function payload(event: string, lead: { email: string }, account: Account, extra: Record<string, unknown> = {}) {
  return {
    timestamp: new Date(NOW.getTime() - 60_000).toISOString(),
    event_type: event,
    workspace: `${TAG}.ws`,
    campaign_id: account.campaign,
    campaign_name: `zx-sender-${account.identifier}`,
    lead_email: lead.email,
    email_account: account.identifier,
    ...extra,
  };
}

async function post(p: Record<string, unknown>) {
  const outcome = await processInstantlyEvent(webhookDeps(), p);
  fixture.eventIds.push(outcome.eventId);
  return outcome;
}

async function leadState(id: string): Promise<string | null> {
  const { data } = await db.from("leads").select("state").eq("id", id).single();
  return data?.state ?? null;
}
async function touch(id: string) {
  const { data } = await db.from("touches").select("status, sent_at, provider_message_id").eq("id", id).single();
  return data!;
}
async function enrollment(id: string) {
  const { data } = await enrollDb.from("instantly_enrollments").select("state, stop_reason, removed_at").eq("id", id).single();
  return data!;
}
async function exceptionsFor(kind: string, leadId?: string) {
  let q = db.from("exceptions").select("status, detail").eq("kind", kind);
  q = leadId ? q.eq("lead_id", leadId) : q.in("detail->>send_account_id", fixture.accountIds);
  const { data } = await q;
  return data ?? [];
}
async function ledgerDay(accountId: string) {
  const { data } = await db.from("capacity_ledger").select("used, accepted, quota").eq("send_account_id", accountId).eq("date", TODAY).maybeSingle();
  return data;
}
async function eventsFor(leadId: string, event: string) {
  const { data } = await db.from("lead_events").select("detail").eq("lead_id", leadId).eq("event", event);
  return data ?? [];
}

/** Common assertions for a stop that removed the lead. */
async function assertRemoved(label: string, f: Enrolled, reason: string, deletesBefore: number): Promise<void> {
  const e = await enrollment(f.enrollmentId);
  const t2 = await touch(f.touches[2]!);
  const t3 = await touch(f.touches[3]!);
  assert(`${label}: DELETE ×1 for its Instantly lead`, calls("deleteLead", f.providerLeadId) - deletesBefore === 1, `${calls("deleteLead", f.providerLeadId) - deletesBefore}`);
  assert(`${label}: confirmed by GET 404 (lead gone at Instantly)`, calls("getLead", f.providerLeadId) >= 1 && !inst.leads.get(f.providerLeadId)!.present);
  assert(`${label}: enrollment removed, stop_reason ${reason}`, e.state === "removed" && e.stop_reason === reason && e.removed_at !== null, JSON.stringify(e));
  assert(`${label}: follow-ups 2 and 3 killed`, t2.status === "killed" && t3.status === "killed", `${t2.status}/${t3.status}`);
}

// ---------------------------------------------------------------------------
// T — tracking
// ---------------------------------------------------------------------------

async function trackingCases(): Promise<void> {
  console.log("\n--- T1: email_sent step 2 (+ redelivery, + same-email variant) ---");
  const a = await createAccount("t1");
  const f = await enrolledLead("t1", a);
  const sentAt = new Date(NOW.getTime() - 120_000).toISOString();
  const p2 = payload("email_sent", f, a, { step: 2, variant: 1, email_id: `${TAG}.e2`, timestamp: sentAt });
  const first = await post(p2);
  const t2 = await touch(f.touches[2]!);
  let day = await ledgerDay(a.id);
  assert("T1: processed sent_recorded", first.kind === "processed" && first.action === "sent_recorded", JSON.stringify(first));
  assert(
    "T1: touch 2 sent, provider_message_id = email_id, sent_at = the event time",
    t2.status === "sent" && t2.provider_message_id === `${TAG}.e2` && Date.parse(t2.sent_at!) === Date.parse(sentAt),
    JSON.stringify(t2),
  );
  assert("T1: ledger used 1, accepted 1 (record_provider_send)", day?.used === 1 && day?.accepted === 1, JSON.stringify(day));
  const dup = await post(p2);
  assert("T1: exact redelivery → duplicate", dup.kind === "duplicate", JSON.stringify(dup));
  const variant = await post({ ...p2, timestamp: new Date(NOW.getTime() - 90_000).toISOString() });
  day = await ledgerDay(a.id);
  const t2b = await touch(f.touches[2]!);
  assert("T1: same email_id via a second delivery → processed, ledger still used 1 (counted once)", variant.kind === "processed" && day?.used === 1 && day?.accepted === 1, JSON.stringify(day));
  assert("T1: touch 2 unchanged by the second delivery", t2b.sent_at === t2.sent_at && t2b.status === "sent");
  const checks = inst.enqueued.filter((j) => j.idempotencyKey === `recipient_check:${TAG}.e2`);
  assert(
    "T1: the recipient check is queued as send.recipient_check, one idempotency key, ≥ 60 s later, for touch 2",
    checks.length >= 1 &&
      checks.every((c) => c.type === "send.recipient_check" && c.payload.touch_id === f.touches[2] && c.payload.step === 2) &&
      Date.parse(checks[0]!.runAfter!) - NOW.getTime() >= 60_000,
    JSON.stringify(checks[0]),
  );

  const p1 = payload("email_sent", f, a, { step: 1, email_id: `${TAG}.e1`, timestamp: new Date(NOW.getTime() - 3_000_000).toISOString() });
  await post(p1);
  const t1 = await touch(f.touches[1]!);
  day = await ledgerDay(a.id);
  assert("T1: step 1 → touch 1 gets provider_message_id (06 §6 row), ledger unchanged (its reservation counted it)", t1.provider_message_id === `${TAG}.e1` && day?.used === 1, `${t1.provider_message_id} used=${day?.used}`);
  assert("T1: step 1 also queues a recipient check", inst.enqueued.some((j) => j.idempotencyKey === `recipient_check:${TAG}.e1`));

  console.log("\n--- T2: email_sent without step / out of range ---");
  const before2 = await touch(f.touches[3]!);
  const noStep = await post(payload("email_sent", f, a, { email_id: `${TAG}.e-nostep`, timestamp: new Date(NOW.getTime() - 50_000).toISOString() }));
  const oor = await post(payload("email_sent", f, a, { step: 4, email_id: `${TAG}.e-step4`, timestamp: new Date(NOW.getTime() - 40_000).toISOString() }));
  const api = await post(payload("email_sent", f, a, { step: "0_1_0", email_id: `${TAG}.e-api`, timestamp: new Date(NOW.getTime() - 30_000).toISOString() }));
  const ex = await exceptionsFor("sent_step_unknown", f.leadId);
  const reasons = ex.map((e) => (e.detail as Record<string, unknown>).reason).sort();
  day = await ledgerDay(a.id);
  assert(
    "T2: no step / step 4 of 3 / the API's \"0_1_0\" → exception sent_step_unknown (all escalated)",
    noStep.kind === "exception" && oor.kind === "exception" && api.kind === "exception" && ex.length === 3 && ex.every((e) => e.status === "escalated"),
    JSON.stringify(reasons),
  );
  assert("T2: reasons no_step ×2, step_out_of_range ×1", JSON.stringify(reasons) === JSON.stringify(["no_step", "no_step", "step_out_of_range"]), JSON.stringify(reasons));
  const after2 = await touch(f.touches[3]!);
  assert("T2: no touch change, ledger unchanged", after2.status === before2.status && after2.provider_message_id === null && day?.used === 1, `${after2.status} used=${day?.used}`);
}

// ---------------------------------------------------------------------------
// T3 — recipient check
// ---------------------------------------------------------------------------

async function recipientCases(): Promise<void> {
  const variants: Array<{ name: string; email: (lead: string, own: string) => MockEmail; issues: string[] }> = [
    { name: "own mailbox in To", email: (lead, own) => ({ to: `${own}, ${lead}` }), issues: ["own_address_in_to", "lead_not_sole_to"] },
    { name: "own-domain Cc", email: (lead) => ({ to: lead, cc: "someone@mail.zyndix.com" }), issues: ["own_address_in_cc", "cc_not_empty"] },
    { name: "lead missing", email: () => ({ to: `other@elsewhere.${TAG}.example.invalid` }), issues: ["lead_not_sole_to"] },
  ];
  for (const [i, v] of variants.entries()) {
    console.log(`\n--- T3 (${v.name}) ---`);
    const a = await createAccount(`t3${i}`);
    const f = await enrolledLead(`t3${i}`, a);
    const other = await enrolledLead(`t3${i}o`, a); // another in-flight lead of the same sender
    const emailId = `${TAG}.t3${i}.e2`;
    await post(payload("email_sent", f, a, { step: 2, email_id: emailId, timestamp: new Date(NOW.getTime() - 100_000).toISOString() }));
    inst.emails.set(emailId, v.email(f.email, a.identifier));
    const alertsBefore = inst.alerts.length;
    const out = await runRecipientCheck(checkDeps(), {
      payload: { lead_id: f.leadId, touch_id: f.touches[2]!, email_id: emailId, step: 2, send_account_id: a.id },
      attempt: 1,
      maxAttempts: 5,
    });
    const ex = await exceptionsFor("recipient_misaddressed", f.leadId);
    const t2 = await touch(f.touches[2]!);
    const day = await ledgerDay(a.id);
    const e = await enrollment(f.enrollmentId);
    const eo = await enrollment(other.enrollmentId);
    const { data: acct } = await db.from("send_accounts").select("health").eq("id", a.id).single();
    assert(
      `T3 ${v.name}: recipient_misaddressed with issues ${v.issues.join(",")}`,
      out.kind === "misaddressed" && JSON.stringify(out.issues) === JSON.stringify(v.issues) && ex.length === 1 && ex[0]!.status === "escalated",
      JSON.stringify(out),
    );
    assert(`T3 ${v.name}: touch 2 failed, capacity still counted (used 1)`, t2.status === "failed" && day?.used === 1, `${t2.status} used=${day?.used}`);
    assert(`T3 ${v.name}: lead manual_hold`, (await leadState(f.leadId)) === "manual_hold");
    assert(`T3 ${v.name}: DELETE ×1, enrollment removed (recipient_misaddressed)`, calls("deleteLead", f.providerLeadId) === 1 && e.state === "removed" && e.stop_reason === "recipient_misaddressed", JSON.stringify(e));
    assert(
      `T3 ${v.name}: sender paused (health + campaign ×1), its other in-flight lead stopped and held`,
      acct?.health === "paused" && calls("pauseCampaign", a.campaign) === 1 && eo.state === "removed" && eo.stop_reason === "sender_paused" && (await leadState(other.leadId)) === "manual_hold",
      `${acct?.health} pause=${calls("pauseCampaign", a.campaign)} other=${JSON.stringify(eo)}`,
    );
    assert(`T3 ${v.name}: operator alerted`, inst.alerts.length > alertsBefore && inst.alerts.slice(alertsBefore).some((t) => t.includes("recipient_misaddressed")));
    if (i === 0) {
      const replay = await runRecipientCheck(checkDeps(), {
        payload: { lead_id: f.leadId, touch_id: f.touches[2]!, email_id: emailId, step: 2, send_account_id: a.id },
        attempt: 2,
        maxAttempts: 5,
      });
      assert("T3 replay: the same job again → already_handled, no second exception", replay.kind === "already_handled" && (await exceptionsFor("recipient_misaddressed", f.leadId)).length === 1);
    }
  }

  console.log("\n--- T3+ (To = [lead], Cc/Bcc empty) ---");
  const a = await createAccount("t3p");
  const f = await enrolledLead("t3p", a);
  const emailId = `${TAG}.t3p.e2`;
  await post(payload("email_sent", f, a, { step: 2, email_id: emailId, timestamp: new Date(NOW.getTime() - 100_000).toISOString() }));
  inst.emails.set(emailId, { to: `Test Lead <${f.email.toUpperCase()}>`, cc: "", bcc: null });
  const out = await runRecipientCheck(checkDeps(), {
    payload: { lead_id: f.leadId, touch_id: f.touches[2]!, email_id: emailId, step: 2, send_account_id: a.id },
    attempt: 1,
    maxAttempts: 5,
  });
  const passed = await eventsFor(f.leadId, "recipient_check_passed");
  assert(
    "T3+: passed → recipient_check_passed, touch sent, lead sent, no DELETE, no pause",
    out.kind === "passed" && passed.length === 1 && (await touch(f.touches[2]!)).status === "sent" && (await leadState(f.leadId)) === "sent" && calls("deleteLead", f.providerLeadId) === 0 && calls("pauseCampaign", a.campaign) === 0,
    JSON.stringify(out),
  );

  console.log("\n--- T3 unreadable (getEmail 404 until the last attempt) ---");
  const u = await createAccount("t3u");
  const fu = await enrolledLead("t3u", u);
  const job = { payload: { lead_id: fu.leadId, touch_id: fu.touches[1]!, email_id: `${TAG}.never`, step: 1, send_account_id: u.id }, maxAttempts: 3 };
  let threw = false;
  try {
    await runRecipientCheck(checkDeps(), { ...job, attempt: 1 });
  } catch {
    threw = true;
  }
  assert("T3 unreadable: attempt 1 of 3 throws (the job backs off), nothing recorded", threw && (await leadState(fu.leadId)) === "sent");
  const last = await runRecipientCheck(checkDeps(), { ...job, attempt: 3 });
  const eu = await enrollment(fu.enrollmentId);
  assert(
    "T3 unreadable: last attempt → recipient_check_unreadable escalated, lead manual_hold, sequence stopped, sender NOT paused",
    last.kind === "unreadable" && (await exceptionsFor("recipient_check_unreadable", fu.leadId)).length === 1 && (await leadState(fu.leadId)) === "manual_hold" && eu.state === "removed" && calls("pauseCampaign", u.campaign) === 0,
    JSON.stringify(eu),
  );
}

// ---------------------------------------------------------------------------
// S — stops
// ---------------------------------------------------------------------------

async function stopCases(): Promise<void> {
  console.log("\n--- S1: reply ---");
  const a = await createAccount("s");
  const s1 = await enrolledLead("s1", a);
  const r = await post(payload("reply_received", s1, a, { email_id: `${TAG}.s1.reply`, reply_subject: "Re: Your contact page", reply_text: "Not now, thanks." }));
  assert("S1: reply frozen → replied", r.kind === "processed" && (await leadState(s1.leadId)) === "replied");
  await assertRemoved("S1", s1, "reply_received", 0);

  console.log("\n--- S2: unsubscribe (block list + delete) ---");
  const s2 = await enrolledLead("s2", a);
  fixture.suppressionEmails.push(s2.email);
  await post(payload("lead_unsubscribed", s2, a, { email_id: `${TAG}.s2.unsub` }));
  assert("S2: suppressed + block list", (await leadState(s2.leadId)) === "suppressed" && calls("addBlockListEntry", s2.email) === 1);
  await assertRemoved("S2", s2, "unsubscribed", 0);

  console.log("\n--- S3: bounce ---");
  const b = await createAccount("s3");
  const s3 = await enrolledLead("s3", b);
  fixture.suppressionEmails.push(s3.email);
  await post(payload("email_bounced", s3, b, { email_id: `${TAG}.s3.bounce` }));
  assert("S3: bounced", (await leadState(s3.leadId)) === "bounced");
  await assertRemoved("S3", s3, "bounced", 0);
  const deleteIdx = inst.calls.findIndex((c) => c.op === "deleteLead" && c.arg === s3.providerLeadId);
  const pauseIdx = inst.calls.findIndex((c) => c.op === "pauseCampaign" && c.arg === b.campaign);
  assert("S3: the lead is stopped before the bounce-rate auto-pause", deleteIdx >= 0 && pauseIdx > deleteIdx, `delete@${deleteIdx} pause@${pauseIdx}`);

  console.log("\n--- S4: manual hold ---");
  const s4 = await enrolledLead("s4", a);
  const held = await holdAndStop(stopDeps(), s4.leadId, "manual_hold_by_operator", { tag: TAG });
  assert("S4: sent → manual_hold", held.held && held.from === "sent" && (await leadState(s4.leadId)) === "manual_hold");
  await assertRemoved("S4", s4, "manual_hold", 0);

  console.log("\n--- S5: suppression added outside the webhook path (found by the sweep) ---");
  const c = await createAccount("s5");
  const s5 = await enrolledLead("s5", c);
  fixture.suppressionEmails.push(s5.email);
  const { error: supError } = await db.from("suppression_list").insert({ email: s5.email, domain: s5.email.split("@")[1], reason: `${TAG}.operator` });
  if (supError) throw new Error(`S5 suppression: ${supError.message}`);
  const sweep = await runInstantlyLeadSweep(reconcileDeps(), { sendAccountIds: [c.id] });
  assert("S5: sweep found it → lead suppressed", sweep.suppressed_found === 1 && (await leadState(s5.leadId)) === "suppressed", JSON.stringify(sweep));
  await assertRemoved("S5", s5, "suppressed", 0);

  console.log("\n--- S6: sender pause (campaign first, then every in-flight lead) ---");
  const d = await createAccount("s6");
  const s6a = await enrolledLead("s6a", d);
  const s6b = await enrolledLead("s6b", d);
  const mark = inst.calls.length;
  const paused = await pauseSender(stopDeps(), { account: { id: d.id, identifier: d.identifier, instantly_campaign_id: d.campaign }, reason: `${TAG} operator pause`, why: "S6 test" });
  const slice = inst.calls.slice(mark);
  const firstPause = slice.findIndex((x) => x.op === "pauseCampaign");
  const firstDelete = slice.findIndex((x) => x.op === "deleteLead");
  assert("S6: pauseCampaign before any DELETE", firstPause >= 0 && firstDelete > firstPause, slice.map((x) => x.op).join(","));
  assert("S6: 2 leads removed, 0 failed", paused.campaignPaused && paused.leadsStopped === 2 && paused.leadsStopFailed === 0, JSON.stringify(paused));
  await assertRemoved("S6 lead a", s6a, "sender_paused", 0);
  await assertRemoved("S6 lead b", s6b, "sender_paused", 0);
  assert("S6: both leads manual_hold", (await leadState(s6a.leadId)) === "manual_hold" && (await leadState(s6b.leadId)) === "manual_hold");

  console.log("\n--- S7: booking hook (U8 calls stopSequence) ---");
  const s7 = await enrolledLead("s7", a);
  const booked = await stopSequence(stopDeps(), s7.leadId, "meeting_booked");
  assert("S7: removed", booked.outcome === "removed" && booked.attempts === 1, JSON.stringify(booked));
  await assertRemoved("S7", s7, "meeting_booked", 0);
  const again = await stopSequence(stopDeps(), s7.leadId, "meeting_booked");
  assert("S7: a second stop is a no-op (already_removed, no DELETE)", again.outcome === "already_removed" && calls("deleteLead", s7.providerLeadId) === 1, JSON.stringify(again));

  console.log("\n--- S8: DELETE 500 twice, lead still present ---");
  const e = await createAccount("s8");
  const s8 = await enrolledLead("s8", e);
  inst.deleteBehaviour.set(s8.providerLeadId, ["500", "500"]);
  const failed = await holdAndStop(stopDeps(), s8.leadId, "manual_hold_by_operator");
  const e8 = await enrollment(s8.enrollmentId);
  const ex8 = await exceptionsFor("stop_failed", s8.leadId);
  const { data: acct8 } = await db.from("send_accounts").select("health").eq("id", e.id).single();
  assert("S8: stop_failed after 2 DELETE attempts, each followed by a GET", failed.stop.outcome === "stop_failed" && calls("deleteLead", s8.providerLeadId) === 2 && calls("getLead", s8.providerLeadId) === 2, JSON.stringify(failed.stop));
  assert("S8: enrollment stop_failed; escalated stop_failed (instantly_delete_lead)", e8.state === "stop_failed" && ex8.length === 1 && ex8[0]!.status === "escalated" && (ex8[0]!.detail as Record<string, unknown>).stop === "instantly_delete_lead", JSON.stringify(e8));
  assert("S8: sender paused (health + campaign ×1)", acct8?.health === "paused" && calls("pauseCampaign", e.campaign) === 1, `${acct8?.health} ${calls("pauseCampaign", e.campaign)}`);
  assert("S8: follow-ups killed on the engine side anyway", (await touch(s8.touches[2]!)).status === "killed" && (await touch(s8.touches[3]!)).status === "killed");

  console.log("\n--- S9: DELETE timeout (applied), then GET 404 ---");
  const s9 = await enrolledLead("s9", a);
  inst.deleteBehaviour.set(s9.providerLeadId, ["timeout_applied"]);
  const s9out = await stopSequence(stopDeps(), s9.leadId, "manual_hold");
  assert("S9: removed with no second DELETE", s9out.outcome === "removed" && calls("deleteLead", s9.providerLeadId) === 1, JSON.stringify(s9out));
  await assertRemoved("S9", s9, "manual_hold", 0);

  console.log("\n--- T4: email_sent step 3 after the stop ---");
  const t4 = await post(payload("email_sent", s9, a, { step: 3, email_id: `${TAG}.s9.e3`, timestamp: new Date(NOW.getTime() - 10_000).toISOString() }));
  const t3 = await touch(s9.touches[3]!);
  const after = await exceptionsFor("sent_after_stop", s9.leadId);
  assert(
    "T4: the truth is recorded (touch 3 sent) and sent_after_stop escalated",
    t4.kind === "processed" && t3.status === "sent" && after.length === 1 && after[0]!.status === "escalated" && (after[0]!.detail as Record<string, unknown>).touch_status_before === "killed",
    JSON.stringify(after[0]?.detail),
  );
}

// ---------------------------------------------------------------------------
// R — reconcile sweep
// ---------------------------------------------------------------------------

async function sweepCases(): Promise<void> {
  console.log("\n--- R1: engine replied, Instantly still Active ---");
  const a = await createAccount("r1");
  const r1 = await enrolledLead("r1", a);
  await state.transition(r1.leadId, "sent", "replied", "test_u6c_fixture", { tag: TAG }); // the stop never ran
  const r1absent = await enrolledLead("r1x", a);
  await state.transition(r1absent.leadId, "sent", "manual_hold", "test_u6c_fixture", { tag: TAG });
  inst.leads.get(r1absent.providerLeadId)!.present = false; // already gone at Instantly
  const sweep = await runInstantlyLeadSweep(reconcileDeps(), { sendAccountIds: [a.id] });
  const ex = await exceptionsFor("stopped_lead_active", r1.leadId);
  assert("R1: sweep → DELETE ×1 + escalated stopped_lead_active", calls("deleteLead", r1.providerLeadId) === 1 && ex.length === 1 && ex[0]!.status === "escalated", JSON.stringify(sweep));
  await assertRemoved("R1", r1, "stopped_lead_active", 0);
  const ex2 = await enrollment(r1absent.enrollmentId);
  assert(
    "R1 (already gone): recorded removed quietly — no DELETE, no exception",
    ex2.state === "removed" && calls("deleteLead", r1absent.providerLeadId) === 0 && (await exceptionsFor("stopped_lead_active", r1absent.leadId)).length === 0 && sweep.confirmed_removed === 1,
    JSON.stringify(ex2),
  );
  const live = await enrolledLead("r1live", a);
  const quiet = await runInstantlyLeadSweep(reconcileDeps(), { sendAccountIds: [a.id] });
  assert("R1: a live, still-sent lead is left alone", (await enrollment(live.enrollmentId)).state === "active" && calls("deleteLead", live.providerLeadId) === 0, JSON.stringify(quiet));

  console.log("\n--- R2: unknown Active lead in a zx-sender campaign ---");
  const b = await createAccount("r2");
  const strangerId = `${TAG}.stranger`;
  inst.leads.set(strangerId, { id: strangerId, email: `stranger@${TAG}.example.invalid`, campaign: b.campaign, status: 1, present: true });
  inst.leads.set(`${TAG}.done`, { id: `${TAG}.done`, email: `done@${TAG}.example.invalid`, campaign: b.campaign, status: 3, present: true });
  const mutatingBefore = inst.calls.filter((x) => ["deleteLead", "pauseCampaign", "addBlockListEntry"].includes(x.op)).length;
  const first = await runInstantlyLeadSweep(reconcileDeps(), { sendAccountIds: [b.id] });
  const second = await runInstantlyLeadSweep(reconcileDeps(), { sendAccountIds: [b.id] });
  const unknown = await exceptionsFor("unknown_active_lead");
  const mutatingAfter = inst.calls.filter((x) => ["deleteLead", "pauseCampaign", "addBlockListEntry"].includes(x.op)).length;
  assert(
    "R2: one open unknown_active_lead (the Completed lead is not reported)",
    unknown.length === 1 && unknown[0]!.status === "open" && (unknown[0]!.detail as Record<string, unknown>).provider_lead_id === strangerId,
    JSON.stringify(unknown),
  );
  assert("R2: zero mutating Instantly calls", mutatingAfter === mutatingBefore, `${mutatingBefore} → ${mutatingAfter}`);
  assert("R2: a second sweep does not re-raise it", first.unknown_active_lead === 1 && second.unknown_active_lead === 0, `${first.unknown_active_lead}/${second.unknown_active_lead}`);
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
  "suppression_list",
  "webhook_events",
  "exceptions",
  "instantly_enrollments",
  "capacity_ledger",
  "capacity_reservations",
] as const;

async function count(table: (typeof TABLES)[number]): Promise<number> {
  const { count: n, error } = await (raw as unknown as SupabaseClient<DatabaseWithEnrollments>)
    .from(table as "leads")
    .select("*", { count: "exact", head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return n ?? 0;
}

async function cleanup(): Promise<void> {
  const del = async (label: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await run();
    if (error) console.error(`cleanup ${label}: ${error.message}`);
  };
  const { data: tagged } = await db.from("webhook_events").select("id").eq("provider", "instantly").like("payload->>campaign_id", `${TAG}%`);
  const eventIds = [...new Set([...fixture.eventIds, ...(tagged ?? []).map((r) => r.id)])];
  if (eventIds.length) await del("exceptions(event)", () => db.from("exceptions").delete().in("webhook_event_id", eventIds));
  if (fixture.leadIds.length) await del("exceptions(lead)", () => db.from("exceptions").delete().in("lead_id", fixture.leadIds));
  if (fixture.accountIds.length) await del("exceptions(sender)", () => db.from("exceptions").delete().in("detail->>send_account_id", fixture.accountIds));
  if (eventIds.length) await del("webhook_events", () => db.from("webhook_events").delete().in("id", eventIds));
  for (const email of fixture.suppressionEmails) await del("suppression", () => db.from("suppression_list").delete().ilike("email", email));
  if (fixture.leadIds.length) {
    await del("instantly_enrollments", () => enrollDb.from("instantly_enrollments").delete().in("lead_id", fixture.leadIds));
    await del("touches", () => db.from("touches").delete().in("lead_id", fixture.leadIds));
    await del("lead_events", () => db.from("lead_events").delete().in("lead_id", fixture.leadIds));
    await del("leads", () => db.from("leads").delete().in("id", fixture.leadIds));
  }
  if (fixture.accountIds.length) {
    await del("capacity_reservations", () => db.from("capacity_reservations").delete().in("send_account_id", fixture.accountIds));
    await del("capacity_ledger", () => db.from("capacity_ledger").delete().in("send_account_id", fixture.accountIds));
  }
  if (fixture.companyIds.length) await del("companies", () => db.from("companies").delete().in("id", fixture.companyIds));
  if (fixture.accountIds.length) await del("send_accounts", () => db.from("send_accounts").delete().in("id", fixture.accountIds));
}

async function main(): Promise<void> {
  console.log(`\n=== test-u6c-stops (tag=${TAG}) ===`);
  const before: Record<string, number> = {};
  for (const t of TABLES) before[t] = await count(t);
  console.log(`BEFORE  ${TABLES.map((t) => `${t}=${before[t]}`).join(" ")}`);
  guardFetch();
  try {
    await trackingCases();
    await recipientCases();
    await stopCases();
    await sweepCases();
    assert("no network call escaped the mocks (0 Anthropic, 0 Instantly)", network.length === 0, network.join(", "));
    assert("no getEmail call from the webhook path (the check runs as a job)", inst.calls.filter((x) => x.op === "getEmail").every((x) => inst.emails.has(x.arg) || x.arg === `${TAG}.never`));
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
