import { config } from "dotenv";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import { capacity_defaults } from "../src/lib/settings/seed-content";
import { createStateStore } from "../src/lib/state/core";
import {
  handleInstantlyWebhook,
  WEBHOOK_TOKEN_HEADER,
  type InstantlyWebhookDeps,
} from "../src/lib/webhooks/instantly";
import type { Database } from "../src/types/database";
import type { DatabaseWithWebhooks } from "../src/types/database-extensions";
import type { LeadState } from "../src/types/enums";

// U6 Part 1 DoD against Supabase (09 §U6). Synthetic payloads go through
// handleInstantlyWebhook — the exact function /api/webhooks/instantly calls —
// with a mocked Instantly and a fetch guard that fails on ANY network call
// (so the "no model call before the freeze" rule is proven, not assumed).
// Every row touched is a fixture tagged with TAG, and removed afterwards.
// Lead states move only through lib/state.

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const raw = createServiceClient(url, key);
const db = raw as unknown as SupabaseClient<DatabaseWithWebhooks>;
const state = createStateStore(raw as SupabaseClient<Database>);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];
const skipped: string[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name: string, why: string): void {
  skipped.push(`${name} — ${why}`);
  console.log(`SKIP: ${name} — ${why}`);
}

const STAMP = Date.now();
const TAG = `test.u6.${STAMP}`;
const SECRET = randomBytes(32).toString("hex");
const NOW = new Date();

const fixture = {
  accountIds: [] as string[],
  companyIds: [] as string[],
  leadIds: [] as string[],
  jobIds: [] as string[],
  suppressionEmails: [] as string[],
  eventIds: [] as string[],
};

// Any network call from the code under test is a failure: Instantly is mocked
// below and no model client exists on this path.
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

const mock = {
  blockList: [] as string[],
  paused: [] as string[],
  alerts: [] as string[],
  blockListFails: false,
};

function deps(overrides: Partial<InstantlyWebhookDeps> = {}): InstantlyWebhookDeps {
  return {
    db,
    secret: SECRET,
    transition: state.transition,
    instantly: {
      addBlockListEntry: async (value: string) => {
        mock.blockList.push(value);
        if (mock.blockListFails) throw new Error("synthetic block-list failure (503)");
        return { id: `${TAG}.bl`, bl_value: value, is_domain: false } as never;
      },
      pauseCampaign: async (id: string) => {
        mock.paused.push(id);
        return { id, name: "paused", status: 2 } as never;
      },
    },
    getActiveSetting: async (k: string) => {
      if (k !== "capacity_defaults") throw new Error(`unexpected setting ${k}`);
      return { version: 1, value: capacity_defaults };
    },
    alert: async (text: string) => {
      mock.alerts.push(text);
    },
    now: () => NOW,
    ...overrides,
  };
}

async function post(
  payload: unknown,
  opts: { token?: string | null; deps?: InstantlyWebhookDeps; rawBody?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = opts.token === undefined ? SECRET : opts.token;
  if (token !== null) headers[WEBHOOK_TOKEN_HEADER] = token;
  const req = new Request("http://localhost/api/webhooks/instantly", {
    method: "POST",
    headers,
    body: opts.rawBody ?? JSON.stringify(payload),
  });
  const res = await handleInstantlyWebhook(req, opts.deps ?? deps());
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.eventId === "string") fixture.eventIds.push(body.eventId);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function createAccount(name: string): Promise<{ id: string; identifier: string; campaign: string }> {
  const identifier = `u6-${STAMP}-${name}@zyndixhq.com`;
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
      signature_text: `Test ${name}\nZyndix, Vilnius\nzyndix.com`,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture account: ${error?.message}`);
  fixture.accountIds.push(data.id);
  return { id: data.id, identifier, campaign };
}

type LeadFixture = { leadId: string; email: string; stepOneTouch: string | null };

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

/** A lead walked through lib/state to `until`, bound to the account, with its step-1 touch. */
async function createLead(n: string, account: { id: string }, until: LeadState = "sent"): Promise<LeadFixture> {
  const domain = `${n}.${TAG}.example.invalid`;
  const { data: company, error: companyError } = await db
    .from("companies")
    .insert({ name: `U6 Fixture ${n}`, domain, country: "LT", segment: "test" })
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

  for (const [from, to] of PATH_TO_SENT) {
    await state.transition(lead.id, from, to, "test_u6_fixture", { tag: TAG });
    if (to === until) break;
  }
  // The sender binding is a column, not state.
  const { error: bindError } = await db.from("leads").update({ send_account_id: account.id }).eq("id", lead.id);
  if (bindError) throw new Error(`fixture bind: ${bindError.message}`);

  let stepOneTouch: string | null = null;
  if (until === "sent" || until === "queued") {
    const { data: touch, error } = await db
      .from("touches")
      .insert({
        lead_id: lead.id,
        step_no: 1,
        channel: "email",
        direction: "outbound",
        status: until === "sent" ? "sent" : "uncertain",
        subject: "Your listing pages",
        body: "Hi Test,\n\nA specific observation.",
        send_account_id: account.id,
        sent_at: until === "sent" ? new Date(NOW.getTime() - 3_600_000).toISOString() : null,
      })
      .select("id")
      .single();
    if (error || !touch) throw new Error(`fixture touch: ${error?.message}`);
    stepOneTouch = touch.id;
  }
  return { leadId: lead.id, email, stepOneTouch };
}

async function pendingTouch(leadId: string, channel: "email" | "linkedin_msg", status = "approved"): Promise<string> {
  const { data, error } = await db
    .from("touches")
    .insert({ lead_id: leadId, step_no: 2, channel, direction: "outbound", status, subject: "Re: Your listing pages", body: "Follow-up" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture pending touch: ${error?.message}`);
  return data.id;
}

async function queuedJob(kind: string, payload: Record<string, string>): Promise<string> {
  const { data, error } = await db
    .from("jobs")
    .insert({
      type: `${TAG}.${kind}`,
      payload,
      state: "queued",
      run_after: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture job: ${error?.message}`);
  fixture.jobIds.push(data.id);
  return data.id;
}

function payload(event: string, lead: { email: string }, account: { campaign: string; identifier: string }, extra: Record<string, unknown> = {}) {
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

async function leadRow(id: string) {
  const { data } = await db.from("leads").select("state, email_status, do_not_contact").eq("id", id).single();
  return data!;
}
async function jobState(id: string) {
  const { data } = await db.from("jobs").select("state").eq("id", id).single();
  return data?.state;
}
async function touchStatus(id: string) {
  const { data } = await db.from("touches").select("status").eq("id", id).single();
  return data?.status;
}
async function eventsFor(leadId: string, event?: string) {
  let q = db.from("lead_events").select("event, detail").eq("lead_id", leadId);
  if (event) q = q.eq("event", event);
  const { data } = await q;
  return data ?? [];
}
async function count(table: keyof DatabaseWithWebhooks["public"]["Tables"]): Promise<number> {
  const { count: n, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return n ?? 0;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function authCases(a: { campaign: string; identifier: string }): Promise<void> {
  console.log("\n--- DoD: unauthenticated delivery → 401, zero rows ---");
  const before = { events: await count("webhook_events"), exceptions: await count("exceptions"), leadEvents: await count("lead_events") };
  const p = payload("reply_received", { email: `x@${TAG}.example.invalid` }, a);
  const none = await post(p, { token: null });
  const wrong = await post(p, { token: `${SECRET.slice(0, -1)}0` });
  const unset = await post(p, { deps: deps({ secret: undefined }) });
  const badJson = await post(null, { rawBody: "{not json" });
  const after = { events: await count("webhook_events"), exceptions: await count("exceptions"), leadEvents: await count("lead_events") };
  assert("auth: no token → 401", none.status === 401, String(none.status));
  assert("auth: wrong token → 401", wrong.status === 401, String(wrong.status));
  assert("auth: secret not configured → 500 (fails closed)", unset.status === 500, String(unset.status));
  assert("auth: valid token, invalid JSON → 400", badJson.status === 400, String(badJson.status));
  assert(
    "auth: ZERO rows written by any rejected delivery",
    JSON.stringify(before) === JSON.stringify(after),
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
  );
}

async function duplicateCase(a: { id: string; campaign: string; identifier: string }): Promise<void> {
  console.log("\n--- DoD: the same event twice → duplicate, no state change, no second lead_events row ---");
  const f = await createLead("dup", a);
  const p = payload("reply_received", f, a, { email_id: `${TAG}.dup-reply`, reply_subject: "Re: Your listing pages", reply_text: "Sounds interesting." });
  const first = await post(p);
  const eventsAfterFirst = (await eventsFor(f.leadId)).length;
  const { count: touchesAfterFirst } = await db.from("touches").select("id", { count: "exact", head: true }).eq("lead_id", f.leadId);
  const webhookRowsAfterFirst = await count("webhook_events");
  const second = await post({ ...p });
  const { count: touchesAfterSecond } = await db.from("touches").select("id", { count: "exact", head: true }).eq("lead_id", f.leadId);
  assert("dup: first delivery processed → replied", first.status === 200 && first.body.kind === "processed" && (await leadRow(f.leadId)).state === "replied", JSON.stringify(first.body));
  assert("dup: second delivery → duplicate", second.status === 200 && second.body.kind === "duplicate", JSON.stringify(second.body));
  assert("dup: same webhook_events row (no second insert)", second.body.eventId === first.body.eventId && (await count("webhook_events")) === webhookRowsAfterFirst);
  assert("dup: no second lead_events row", (await eventsFor(f.leadId)).length === eventsAfterFirst);
  assert("dup: no second inbound touch", touchesAfterSecond === touchesAfterFirst);
}

async function outOfOrderCase(a: { id: string; campaign: string; identifier: string }): Promise<void> {
  console.log("\n--- DoD: `replied` delivered before `sent` → final state correct ---");
  const f = await createLead("order", a, "queued");
  const reply = await post(
    payload("reply_received", f, a, { email_id: `${TAG}.order-reply`, reply_subject: "Re: Your listing pages", reply_text: "Yes, send it.", timestamp: NOW.toISOString() }),
  );
  const afterReply = (await leadRow(f.leadId)).state;
  const sent = await post(payload("email_sent", f, a, { email_id: `${TAG}.order-step1`, step: 1, timestamp: new Date(NOW.getTime() - 600_000).toISOString() }));
  const final = (await leadRow(f.leadId)).state;
  assert("order: reply on a queued lead → queued → sent → replied", reply.status === 200 && afterReply === "replied", afterReply);
  assert("order: the late email_sent never regresses the state", sent.status === 200 && final === "replied", final);
  const inferred = await eventsFor(f.leadId, "sent_inferred_from_reply");
  const late = await eventsFor(f.leadId, "provider_email_sent");
  assert(
    "order: both events recorded (sent inferred from the reply; late sent logged, state unchanged)",
    inferred.length === 1 && late.length === 1 && (late[0]!.detail as Record<string, unknown>).state_unchanged === "replied",
  );
}

async function replyFreezeCase(a: { id: string; campaign: string; identifier: string }): Promise<void> {
  console.log("\n--- DoD: reply → sent → replied, queued jobs cancelled, no model call ---");
  const f = await createLead("reply", a);
  const followUp = await pendingTouch(f.leadId, "email", "approved");
  const touchJob = await queuedJob("send", { touch_id: followUp });
  const leadJob = await queuedJob("linkedin", { lead_id: f.leadId });
  const networkBefore = network.length;
  const res = await post(payload("reply_received", f, a, { email_id: `${TAG}.reply`, reply_subject: "Re: Your listing pages", reply_text: "What does it cost?" }));
  const { data: inbound } = await db.from("touches").select("id, reply_body").eq("lead_id", f.leadId).eq("direction", "inbound");
  assert("reply: 200 processed", res.status === 200 && res.body.action === "reply_frozen", JSON.stringify(res.body));
  assert("reply: lead sent → replied", (await leadRow(f.leadId)).state === "replied");
  assert("reply: queued send job cancelled", (await jobState(touchJob)) === "cancelled");
  assert("reply: queued lead-level job cancelled", (await jobState(leadJob)) === "cancelled");
  assert("reply: approved follow-up touch killed", (await touchStatus(followUp)) === "killed");
  assert("reply: inbound touch recorded with the reply text", (inbound ?? []).length === 1 && inbound![0]!.reply_body === "What does it cost?");
  assert("reply: ZERO network calls — Anthropic (and everything else) uncalled", network.length === networkBefore, network.slice(networkBefore).join(", "));
  const ev = (await eventsFor(f.leadId, "reply_received"))[0]?.detail as Record<string, unknown> | undefined;
  assert("reply: reply_received event counts what was frozen", ev?.cancelled_jobs === 2 && ev?.killed_touches === 1, JSON.stringify(ev));
}

async function autoReplyCase(a: { id: string; campaign: string; identifier: string }): Promise<void> {
  console.log("\n--- operator case: auto-reply is NOT a reply → lead stays sent, jobs intact ---");
  const f = await createLead("ooo", a);
  const followUp = await pendingTouch(f.leadId, "email", "approved");
  const job = await queuedJob("send", { touch_id: followUp });
  const res = await post(
    payload("auto_reply_received", f, a, {
      email_id: `${TAG}.ooo`,
      reply_subject: "Out of Office",
      reply_text: "Thanks for your email. I am out of the office and will be back on October 12, 2026. For urgent matters contact the front desk.",
    }),
  );
  const ev = (await eventsFor(f.leadId, "auto_reply"))[0]?.detail as Record<string, unknown> | undefined;
  const { count: inbound } = await db.from("touches").select("id", { count: "exact", head: true }).eq("lead_id", f.leadId).eq("direction", "inbound");
  assert("ooo: 200 auto_reply_recorded", res.status === 200 && res.body.action === "auto_reply_recorded", JSON.stringify(res.body));
  assert("ooo: lead stays sent", (await leadRow(f.leadId)).state === "sent");
  assert("ooo: queued job intact", (await jobState(job)) === "queued");
  assert("ooo: follow-up touch intact", (await touchStatus(followUp)) === "approved");
  assert("ooo: no inbound touch (would trip reply_freeze)", inbound === 0);
  assert("ooo: auto_reply event carries return_date 2026-10-12", ev?.return_date === "2026-10-12", JSON.stringify(ev));

  const g = await createLead("ooo-subject", a);
  const job2 = await queuedJob("send", { touch_id: await pendingTouch(g.leadId, "email", "approved") });
  const res2 = await post(payload("reply_received", g, a, { email_id: `${TAG}.ooo2`, reply_subject: "Automatic reply: Your listing pages", reply_text: "I'm away until 5 October." }));
  const ev2 = (await eventsFor(g.leadId, "auto_reply"))[0]?.detail as Record<string, unknown> | undefined;
  assert(
    "ooo: reply_received with an 'Automatic reply:' subject is treated the same (lead sent, job queued)",
    res2.body.action === "auto_reply_recorded" && (await leadRow(g.leadId)).state === "sent" && (await jobState(job2)) === "queued",
    JSON.stringify(res2.body),
  );
  assert("ooo: return date read without a year → next occurrence", typeof ev2?.return_date === "string" && /-10-05$/.test(ev2.return_date as string), String(ev2?.return_date));
}

async function unsubscribeCase(a: { id: string; campaign: string; identifier: string }): Promise<void> {
  console.log("\n--- DoD: unsubscribe → suppression row + cancelled email AND linkedin_msg jobs ---");
  const f = await createLead("unsub", a);
  fixture.suppressionEmails.push(f.email);
  const emailTouch = await pendingTouch(f.leadId, "email", "approved");
  const liTouch = await pendingTouch(f.leadId, "linkedin_msg", "pending_approval");
  const emailJob = await queuedJob("send", { touch_id: emailTouch });
  const liJob = await queuedJob("linkedin", { touch_id: liTouch });
  const blockBefore = mock.blockList.length;
  const res = await post(payload("lead_unsubscribed", f, a));
  const { data: rows } = await db.from("suppression_list").select("email, domain, reason").ilike("email", f.email);
  const lead = await leadRow(f.leadId);
  assert("unsub: 200 suppressed", res.status === 200 && res.body.action === "suppressed", JSON.stringify(res.body));
  assert("unsub: one person-level suppression row (email set)", (rows ?? []).length === 1 && rows![0]!.email === f.email && rows![0]!.reason === "unsubscribe");
  assert("unsub: lead → suppressed, do_not_contact", lead.state === "suppressed" && lead.do_not_contact === true, JSON.stringify(lead));
  assert("unsub: email job cancelled", (await jobState(emailJob)) === "cancelled");
  assert("unsub: linkedin_msg job cancelled", (await jobState(liJob)) === "cancelled");
  assert("unsub: both channels' touches killed", (await touchStatus(emailTouch)) === "killed" && (await touchStatus(liTouch)) === "killed");
  assert("unsub: Instantly block list called once with the address", mock.blockList.length === blockBefore + 1 && mock.blockList.at(-1) === f.email);

  console.log("\n--- failed stop → escalated exception, engine still stopped ---");
  const g = await createLead("unsub-fail", a);
  fixture.suppressionEmails.push(g.email);
  mock.blockListFails = true;
  const alertsBefore = mock.alerts.length;
  const res2 = await post(payload("lead_unsubscribed", g, a));
  mock.blockListFails = false;
  const { data: exc } = await db.from("exceptions").select("kind, status, escalated_at").eq("webhook_event_id", String(res2.body.eventId));
  assert(
    "stop_failed: exception escalated + operator alerted; lead still suppressed",
    exc?.length === 1 && exc[0]!.kind === "stop_failed" && exc[0]!.status === "escalated" && Boolean(exc[0]!.escalated_at) &&
      mock.alerts.length === alertsBefore + 1 && (await leadRow(g.leadId)).state === "suppressed",
    JSON.stringify(exc),
  );
}

async function unknownRecipientCase(a: { id: string; campaign: string; identifier: string }): Promise<void> {
  console.log("\n--- DoD: unknown recipient → one exception, zero lead mutations ---");
  const before = { leads: await count("leads"), leadEvents: await count("lead_events"), touches: await count("touches") };
  const res = await post(payload("reply_received", { email: `nobody@unknown.${TAG}.example.invalid` }, a, { email_id: `${TAG}.unknown` }));
  const after = { leads: await count("leads"), leadEvents: await count("lead_events"), touches: await count("touches") };
  const { data: exc } = await db.from("exceptions").select("kind, status").eq("webhook_event_id", String(res.body.eventId));
  assert("unknown: 200 with exception unmatched_recipient", res.status === 200 && res.body.exception === "unmatched_recipient", JSON.stringify(res.body));
  assert("unknown: exactly one exceptions row", exc?.length === 1 && exc[0]!.kind === "unmatched_recipient" && exc[0]!.status === "open");
  assert("unknown: zero lead mutations (leads, lead_events, touches unchanged)", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

  const foreign = await post(payload("reply_received", { email: `x@${TAG}.example.invalid` }, { campaign: `${TAG}.not-ours`, identifier: "someone@elsewhere.example.invalid" }));
  assert("foreign campaign → exception foreign_campaign", foreign.body.exception === "foreign_campaign", JSON.stringify(foreign.body));

  const invalid = await post({ campaign_id: a.campaign, lead_email: `x@${TAG}.example.invalid` });
  assert("no event_type → stored, exception invalid_payload, 200", invalid.status === 200 && invalid.body.exception === "invalid_payload", JSON.stringify(invalid.body));

  const opened = await post(payload("email_opened", { email: `nobody@${TAG}.example.invalid` }, a));
  assert("an event we do not act on (email_opened) → recorded only", opened.body.action === "recorded_only", JSON.stringify(opened.body));
}

async function bounceCase(): Promise<void> {
  console.log("\n--- bounce → email invalid, suppression, bounce-rate auto-pause ---");
  const b = await createAccount("bounce");
  const f = await createLead("bounce", b);
  fixture.suppressionEmails.push(f.email);
  const pausedBefore = mock.paused.length;
  const res = await post(payload("email_bounced", f, b, { email_id: `${TAG}.bounce` }));
  const lead = await leadRow(f.leadId);
  const { data: account } = await db.from("send_accounts").select("health, paused_reason, bounce_rate_7d").eq("id", b.id).single();
  const { data: rows } = await db.from("suppression_list").select("reason").ilike("email", f.email);
  assert("bounce: lead sent → bounced, email_status invalid", res.status === 200 && lead.state === "bounced" && lead.email_status === "invalid", JSON.stringify(lead));
  assert("bounce: person-level suppression row", rows?.length === 1 && rows[0]!.reason === "bounce");
  assert("bounce: step-1 touch marked bounced", (await touchStatus(f.stepOneTouch!)) === "bounced");
  assert(
    "bounce: 1/1 in 7d > 3% → account paused, reason recorded",
    account?.health === "paused" && Number(account.bounce_rate_7d) === 1 && /bounce_rate_7d/.test(account.paused_reason ?? ""),
    JSON.stringify(account),
  );
  assert("bounce: its Instantly campaign paused (mock) + operator alerted", mock.paused.length === pausedBefore + 1 && mock.paused.at(-1) === b.campaign && mock.alerts.some((t) => t.includes("auto-paused")));
}

// ---------------------------------------------------------------------------
// Counts, cleanup
// ---------------------------------------------------------------------------

const TABLES = ["leads", "touches", "lead_events", "jobs", "companies", "send_accounts", "suppression_list", "webhook_events", "exceptions"] as const;

async function migrationApplied(): Promise<boolean> {
  const { error } = await db.from("exceptions").select("id").limit(1);
  if (!error) {
    const { error: colError } = await db.from("send_accounts").select("signature_text").limit(1);
    return !colError;
  }
  if (error.code === "PGRST205" || /schema cache/i.test(error.message)) return false;
  throw new Error(`exceptions probe: ${error.message}`);
}

async function cleanup(): Promise<void> {
  const del = async (label: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await run();
    if (error) console.error(`cleanup ${label}: ${error.message}`);
  };
  // Events written for payloads that matched nothing still carry the TAG.
  const { data: tagged } = await db.from("webhook_events").select("id").eq("provider", "instantly").like("payload->>lead_email", `%${TAG}%`);
  const { data: taggedCampaign } = await db.from("webhook_events").select("id").eq("provider", "instantly").like("payload->>campaign_id", `${TAG}%`);
  const eventIds = [...new Set([...fixture.eventIds, ...(tagged ?? []).map((r) => r.id), ...(taggedCampaign ?? []).map((r) => r.id)])];
  if (eventIds.length) await del("exceptions", () => db.from("exceptions").delete().in("webhook_event_id", eventIds));
  if (fixture.leadIds.length) await del("exceptions(lead)", () => db.from("exceptions").delete().in("lead_id", fixture.leadIds));
  if (eventIds.length) await del("webhook_events", () => db.from("webhook_events").delete().in("id", eventIds));
  if (fixture.jobIds.length) await del("jobs", () => db.from("jobs").delete().in("id", fixture.jobIds));
  // Suppression rows reference touches (source_touch_id): remove them first.
  for (const email of fixture.suppressionEmails) {
    await del("suppression", () => db.from("suppression_list").delete().ilike("email", email));
  }
  if (fixture.leadIds.length) {
    await del("touches", () => db.from("touches").delete().in("lead_id", fixture.leadIds));
    await del("lead_events", () => db.from("lead_events").delete().in("lead_id", fixture.leadIds));
    await del("leads", () => db.from("leads").delete().in("id", fixture.leadIds));
  }
  if (fixture.companyIds.length) await del("companies", () => db.from("companies").delete().in("id", fixture.companyIds));
  if (fixture.accountIds.length) await del("send_accounts", () => db.from("send_accounts").delete().in("id", fixture.accountIds));
}

async function main(): Promise<void> {
  console.log(`\n=== test-u6-webhooks (tag=${TAG}) ===`);
  if (!(await migrationApplied())) {
    skip("all U6 DB checks", "exceptions / send_accounts.signature_text not found — apply 0009_send_prereqs.sql and 0009b_exceptions.sql");
  } else {
    const before: Record<string, number> = {};
    for (const t of TABLES) before[t] = await count(t);
    console.log(`BEFORE  ${TABLES.map((t) => `${t}=${before[t]}`).join(" ")}`);
    guardFetch();
    try {
      const a = await createAccount("a");
      await authCases(a);
      await duplicateCase(a);
      await outOfOrderCase(a);
      await replyFreezeCase(a);
      await autoReplyCase(a);
      await unsubscribeCase(a);
      await unknownRecipientCase(a);
      await bounceCase();
      assert("no network call escaped the mocks during the whole run", network.length === 0, network.join(", "));
    } catch (error) {
      assert("no unexpected exception", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    } finally {
      globalThis.fetch = realFetch;
      await cleanup();
      console.log("\nCleanup: fixture rows removed.");
    }
    const after: Record<string, number> = {};
    for (const t of TABLES) after[t] = await count(t);
    console.log(`AFTER   ${TABLES.map((t) => `${t}=${after[t]}`).join(" ")}`);
    for (const t of TABLES) assert(`${t} count unchanged`, before[t] === after[t], `${before[t]} → ${after[t]}`);
  }

  const failed = results.filter((r) => !r.pass);
  if (skipped.length > 0) {
    console.log(`\n${skipped.length} check(s) SKIPPED:`);
    for (const s of skipped) console.log(`  - ${s}`);
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${results.length} check(s) FAILED.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} checks passed.${skipped.length ? " (with skips — NOT a DoD pass)" : ""}`);
  if (skipped.length) process.exit(1);
}

main().catch((error: unknown) => {
  console.error("test-u6-webhooks crashed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
