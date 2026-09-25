import { config } from "dotenv";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import type { AnthropicClient } from "../src/lib/integrations/anthropic";
import type { ApifyClient } from "../src/lib/integrations/apify";
import { InstantlyRetryableError } from "../src/lib/integrations/instantly";
import type { InstantlyAccount, InstantlyEmail } from "../src/lib/integrations/instantly-types";
import type { MillionVerifierClient } from "../src/lib/integrations/millionverifier";
import type { TelegramClient } from "../src/lib/integrations/telegram";
import { createJobQueue } from "../src/lib/jobs/queue";
import type { JobContext } from "../src/lib/jobs/registry";
import { POLL_SOURCE, type ReconcileDeps, runReplyPoll, runStaleStopCheck } from "../src/lib/reconcile/core";
import { createCapacityLedger } from "../src/lib/scheduler/ledger";
import { capacity_defaults, send_policy, send_windows } from "../src/lib/settings/seed-content";
import { createSettingsStore } from "../src/lib/settings/core";
import { runDraftStage } from "../src/lib/stages/draft/core";
import { runEnrichStage } from "../src/lib/stages/enrich/core";
import { runQualifyStage } from "../src/lib/stages/qualify/core";
import { enqueueSend, runSendJob, SEND_JOB_TYPE, type SendDeps } from "../src/lib/stages/send/core";
import { runVerifyStage } from "../src/lib/stages/verify/core";
import { createStateStore } from "../src/lib/state/core";
import { processTelegramUpdate } from "../src/lib/telegram/handler";
import { handleInstantlyWebhook, type InstantlyWebhookDeps, WEBHOOK_TOKEN_HEADER } from "../src/lib/webhooks/instantly";
import type { Database } from "../src/types/database";
import type {
  DatabaseWithCapacity,
  DatabaseWithJobs,
  DatabaseWithSending,
  DatabaseWithWebhooks,
} from "../src/types/database-extensions";
import type { LeadState } from "../src/types/enums";

// U6 Part 1 DoD, remaining bullets (09 §U6, Session 13):
//
//   * One synthetic lead traverses sourced → enriching → qualifying →
//     qualified → verifying → drafting → pending_approval → approved →
//     queued → sent through the REAL stage code (enrich, qualify, verify,
//     draft, the Telegram approve handler, the send job), with every provider
//     mocked: Apify, Anthropic, Apollo, MillionVerifier, Telegram, Instantly.
//   * Eight siblings take the same path with one stop injected, and each
//     proves the lead never reaches `sent` with ZERO enroll calls:
//       1 null hypothesis (insufficient evidence) at qualify → parked
//       2 invalid email at verify → parked + suppression
//       3 email suppressed after approval → suppressed_email
//       4 company domain suppressed after approval → suppressed_domain
//       5 reply webhook before the send → job cancelled, reply_freeze
//       6 unsubscribe webhook → suppressed, email + linkedin_msg jobs cancelled
//       7 meeting booked → booking_hold
//       8 stop_processing_stale pauses the sender → sender_unhealthy, and
//         the send makes zero Instantly calls of ANY kind
//   * Reconcile: stale detection, the poll-row exclusion, missed-reply
//     polling through the webhook processor, dedupe by email id in both
//     orders, unmatched mail, auto-reply dedupe, and truncation (429 /
//     page cap) with the two-in-a-row escalation.
//
// Every stage is scoped to fixture lead ids and reconcile to fixture senders,
// so the real leads (10 qualifying, 1 enriching at the time of writing) are
// never picked. A fetch guard fails any network call other than Supabase.
// Lead states move only through lib/state. All fixture rows are removed.

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const raw = createServiceClient(url, key);
const db = raw as unknown as SupabaseClient<DatabaseWithWebhooks>;
const sendDb = raw as unknown as SupabaseClient<DatabaseWithSending>;
const baseDb = raw as SupabaseClient<Database>;
const state = createStateStore(baseDb);
const settings = createSettingsStore(baseDb);
const ledger = createCapacityLedger(raw as unknown as SupabaseClient<DatabaseWithCapacity>);
const queue = createJobQueue(raw as unknown as SupabaseClient<DatabaseWithJobs>);

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
const TAG = `test.u6t.${STAMP}`;
const SECRET = randomBytes(32).toString("hex");
const START = new Date();
/** Tuesday 09:00 Vilnius: inside the send window, as in test-u5-send. */
const INSIDE = new Date("2026-09-29T06:00:00.000Z");
const APPROVER = Number.parseInt((process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",")[0]?.trim() ?? "", 10);

const fixture = {
  accountIds: [] as string[],
  companyIds: [] as string[],
  leadIds: [] as string[],
  jobIds: [] as string[],
  suppressionEmails: [] as string[],
  suppressionDomains: [] as string[],
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
// Provider mocks
// ---------------------------------------------------------------------------

type QualifyBehaviour = "fit" | "no_evidence";

const mock = {
  apifyRuns: 0,
  qualifyCalls: 0,
  draftCalls: 0,
  reveals: 0,
  verifies: 0,
  telegram: [] as string[],
  alerts: [] as string[],
  instantly: [] as string[],
  enroll: 0,
  paused: [] as string[],
  blockList: [] as string[],
  listEmails: [] as Array<Record<string, unknown>>,
  /** eaccount → received emails served by listEmails. */
  inbox: new Map<string, InstantlyEmail[]>(),
  /** Throw a 429 from listEmails. */
  rateLimited: false,
  /** Serve endless full pages (page-cap truncation). */
  endlessPages: false,
  qualify: new Map<string, QualifyBehaviour>(), // domain → behaviour
  invalidEmails: new Set<string>(),
  emailByPerson: new Map<string, string>(),
};

const DOMAIN_RE = /[a-z0-9-]+\.test\.u6t\.\d+\.example\.invalid/;

const apify = {
  async runAndWait(actorId: string, input: Record<string, unknown>) {
    mock.apifyRuns += 1;
    const domain = JSON.stringify(input).match(DOMAIN_RE)?.[0] ?? "none.example.invalid";
    return {
      runId: `${TAG}.run`,
      actorId,
      status: "SUCCEEDED",
      datasetId: null,
      durationMs: 1,
      itemCount: 1,
      items: [
        {
          url: `https://${domain}/`,
          text: `Roof repair quotes. Request a quote with our contact form; we reply next business day. Built with WordPress.`,
          technologies: [{ name: "WordPress" }],
        },
      ],
    };
  },
  async runAndWaitWith429Backoff(actorId: string, input: Record<string, unknown>) {
    return apify.runAndWait(actorId, input);
  },
} as unknown as ApifyClient;

function completion(text: string) {
  return { text, model: "mock-model", inputTokens: 10, outputTokens: 10, estCostUsd: 0 };
}

const qualifyAnthropic = {
  async complete(params: { user: string }) {
    mock.qualifyCalls += 1;
    const domain = params.user.match(DOMAIN_RE)?.[0] ?? "";
    if (mock.qualify.get(domain) === "no_evidence") {
      // The brief's rule: no evidence → null hypothesis → hold. The qualifier
      // says so with a disqualify reason; nothing is invented.
      return completion(
        JSON.stringify({
          fit_score: 20,
          segment: "roofing",
          problem_hypothesis: null,
          evidence: [],
          triggers: [],
          visible_tools: ["none_detected"],
          recommended_angle: "speed-to-lead",
          disqualify_reason: "insufficient_evidence",
        }),
      );
    }
    return completion(
      JSON.stringify({
        fit_score: 82,
        segment: "roofing",
        problem_hypothesis: "Quote requests wait for a next-business-day reply, so evening enquiries go cold.",
        evidence: [{ source: "website", observation: "Contact page says quote requests are answered the next business day." }],
        triggers: ["contact form only"],
        visible_tools: ["WordPress"],
        recommended_angle: "speed-to-lead",
        disqualify_reason: null,
      }),
    );
  },
} as unknown as AnthropicClient;

const draftAnthropic = {
  async complete(params: { user: string }) {
    mock.draftCalls += 1;
    const name = params.user.match(/"name":\s*"(Traversal Roofing [^"]+)"/)?.[1] ?? "your company";
    return completion(
      JSON.stringify({
        subject: "Evening quote requests",
        body:
          `Hi Tess,\n\nOn the ${name} WordPress contact page, quote requests are answered the next business day. ` +
          `A homeowner who asks in the evening often books whoever replies first.\n\n` +
          `We build small tools that confirm the request right away and route it to the right person.\n\n` +
          `Worth a short call to see if that fits?`,
      }),
    );
  },
} as unknown as AnthropicClient;

const apollo = {
  async revealPersonEmail(personId: string) {
    mock.reveals += 1;
    return { email: mock.emailByPerson.get(personId) ?? null, first_name: "Tess", last_name: "Fixture", linkedin_url: null };
  },
} as never;

const millionverifier = {
  async verifyEmail(email: string) {
    mock.verifies += 1;
    const invalid = mock.invalidEmails.has(email);
    return {
      email,
      raw_result: invalid ? "invalid" : "ok",
      email_status: invalid ? "invalid" : "valid",
      quality: invalid ? "bad" : "good",
      didyoumean: null,
      subresult: null,
      resultcode: invalid ? 6 : 1,
      credits: null,
    };
  },
} as unknown as MillionVerifierClient;

const telegram = {
  async sendApproval() {
    mock.telegram.push("sendApproval");
    return { sent: [1], failed: [] };
  },
  async sendMessage() {
    mock.telegram.push("sendMessage");
    return 1;
  },
  async editMessage() {
    mock.telegram.push("editMessage");
  },
  async answerCallback() {
    mock.telegram.push("answerCallback");
  },
  async sendAlert(text: string) {
    mock.alerts.push(text);
  },
} as unknown as TelegramClient;

function healthyAccount(email: string): InstantlyAccount {
  return {
    email,
    timestamp_created: "2026-09-24T09:00:00.000Z",
    status: 1,
    warmup_status: 1,
    provider_code: 2,
    setup_pending: false,
    stat_warmup_score: 100,
  } as InstantlyAccount;
}

function syntheticEmail(fields: Partial<InstantlyEmail> & { id: string; eaccount: string }): InstantlyEmail {
  return {
    timestamp_created: new Date().toISOString(),
    message_id: `<${fields.id}@target.example.invalid>`,
    subject: "Re: Evening quote requests",
    to_address_email_list: fields.eaccount,
    ue_type: 2,
    ...fields,
  } as InstantlyEmail;
}

const instantly = {
  async enrollLead() {
    mock.instantly.push("enrollLead");
    mock.enroll += 1;
    return { outcome: "created" as const, leadId: randomUUID(), raw: {} as never };
  },
  async replyToEmail() {
    mock.instantly.push("replyToEmail");
    throw new Error("mock: replyToEmail is not expected in this suite");
  },
  async getAccount(email: string) {
    mock.instantly.push("getAccount");
    return healthyAccount(email);
  },
  async getWarmupAnalytics(emails: string[]) {
    mock.instantly.push("getWarmupAnalytics");
    return { aggregate_data: Object.fromEntries(emails.map((e) => [e, { health_score: 100 }])) };
  },
  async findLeadInCampaign() {
    mock.instantly.push("findLeadInCampaign");
    return null;
  },
  async listEmails(params: Record<string, unknown> = {}) {
    mock.instantly.push("listEmails");
    mock.listEmails.push(params);
    if (mock.rateLimited) {
      throw new InstantlyRetryableError(
        "mock: 429",
        { op: "listEmails", method: "GET", path: "/api/v2/emails", status: 429 },
        null,
      );
    }
    if (mock.endlessPages) {
      const items = Array.from({ length: 100 }, (_, i) =>
        syntheticEmail({ id: `${TAG}.flood.${mock.listEmails.length}.${i}`, eaccount: String(params.eaccount), lead: `stranger${i}@elsewhere.example.invalid` }),
      );
      return { items, next_starting_after: `${TAG}.cursor.${mock.listEmails.length}` };
    }
    return { items: mock.inbox.get(String(params.eaccount)) ?? [], next_starting_after: null };
  },
  async pauseCampaign(id: string) {
    mock.instantly.push("pauseCampaign");
    mock.paused.push(id);
    return { id, name: "paused", status: 2 } as never;
  },
  async addBlockListEntry(value: string) {
    mock.instantly.push("addBlockListEntry");
    mock.blockList.push(value);
    return { id: `${TAG}.bl`, bl_value: value, is_domain: false } as never;
  },
};

// Send-related settings come from seed content (as in test-u5-send): the
// fixture senders are not in the live send_policy's assignable list. Every
// other key is the live active version (read-only).
const SEED: Record<string, unknown> = { send_policy, send_windows, capacity_defaults };
async function getActiveSetting(k: string): Promise<{ version: number; value: unknown }> {
  if (k in SEED) return { version: 1, value: SEED[k] };
  const s = await settings.getActiveSetting(k as never);
  return { version: s.version, value: s.value };
}

function sendDeps(now: Date): SendDeps {
  return {
    db: sendDb,
    instantly,
    ledger,
    queue,
    transition: state.transition,
    getActiveSetting,
    alert: async (text) => {
      mock.alerts.push(text);
    },
    now: () => now,
    rng: () => 0.5,
  };
}

function webhookDeps(): InstantlyWebhookDeps {
  return {
    db,
    secret: SECRET,
    transition: state.transition,
    instantly,
    getActiveSetting,
    alert: async (text) => {
      mock.alerts.push(text);
    },
  };
}

function reconcileDeps(): ReconcileDeps {
  return {
    db,
    instantly,
    transition: state.transition,
    getActiveSetting,
    alert: async (text) => {
      mock.alerts.push(text);
    },
  };
}

function jobCtx(touchId: string): JobContext<{ touch_id: string }> {
  return { id: randomUUID(), type: SEND_JOB_TYPE, payload: { touch_id: touchId }, attempt: 1, maxAttempts: 5, idempotencyKey: null };
}

async function postWebhook(payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request("http://localhost/api/webhooks/instantly", {
    method: "POST",
    headers: { "content-type": "application/json", [WEBHOOK_TOKEN_HEADER]: SECRET },
    body: JSON.stringify(payload),
  });
  const res = await handleInstantlyWebhook(req, webhookDeps());
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.eventId === "string") fixture.eventIds.push(body.eventId);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Account = { id: string; identifier: string; campaign: string };

async function createAccount(name: string): Promise<Account> {
  const identifier = `u6t-${STAMP}-${name}@zyndixhq.com`;
  const campaign = `${TAG}.camp-${name}`;
  const { data, error } = await db
    .from("send_accounts")
    .insert({
      kind: "email",
      identifier,
      domain: "zyndixhq.com",
      provider: "test",
      health: "ok",
      ramp_started_on: "2026-09-01",
      instantly_campaign_id: campaign,
      signature_text: `Test ${name}\nZyndix, Vilnius\nzyndix.com`,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture account: ${error?.message}`);
  fixture.accountIds.push(data.id);
  return { id: data.id, identifier, campaign };
}

type Fixture = { leadId: string; companyId: string; domain: string; email: string; name: string };

/**
 * A lead exactly as the source stage leaves it: `sourced`, no email yet, an
 * Apollo person id for verify to reveal. Pre-bound to the fixture sender (a
 * column, not state): the live assignable_senders list excludes fixtures.
 */
async function createSourcedLead(n: string, account: Account): Promise<Fixture> {
  const domain = `${n}.${TAG}.example.invalid`;
  const name = `Traversal Roofing ${n}`;
  const { data: company, error: companyError } = await db
    .from("companies")
    .insert({ name, domain, country: "LT", industry: "Roofing", employee_range: "11-50" })
    .select("id")
    .single();
  if (companyError || !company) throw new Error(`fixture company: ${companyError?.message}`);
  fixture.companyIds.push(company.id);

  const email = `tess@${domain}`;
  const personId = `${TAG}.person.${n}`;
  mock.emailByPerson.set(personId, email);
  const { data: lead, error: leadError } = await db
    .from("leads")
    .insert({
      company_id: company.id,
      first_name: "Tess",
      last_name: "Fixture",
      title: "Owner",
      apollo_person_id: personId,
      timezone: "Europe/Vilnius",
      send_account_id: account.id,
      state: "sourced",
    })
    .select("id")
    .single();
  if (leadError || !lead) throw new Error(`fixture lead: ${leadError?.message}`);
  fixture.leadIds.push(lead.id);
  return { leadId: lead.id, companyId: company.id, domain, email, name };
}

async function leadRow(id: string) {
  const { data, error } = await db.from("leads").select("*").eq("id", id).single();
  if (error || !data) throw new Error(`lead ${id}: ${error?.message}`);
  return data;
}

async function stepOneTouch(leadId: string) {
  const { data } = await sendDb
    .from("touches")
    .select("id, status, approval_hash")
    .eq("lead_id", leadId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

async function history(leadId: string): Promise<string[]> {
  const { data } = await db.from("lead_events").select("detail, created_at").eq("lead_id", leadId).order("created_at");
  return (data ?? [])
    .map((e) => (e.detail as Record<string, unknown> | null)?.to)
    .filter((to): to is string => typeof to === "string");
}

/** enrich → qualify → verify → draft, each stage scoped to this one lead. */
async function runStagesToApproval(f: Fixture): Promise<void> {
  const scope = { leadIds: [f.leadId], limit: 1 };
  await runEnrichStage({ db: baseDb, apify, getActiveSetting, transition: state.transition }, scope);
  await runQualifyStage({ db: baseDb, anthropic: qualifyAnthropic, getActiveSetting, transition: state.transition }, scope);
  await runVerifyStage({ db: baseDb, millionverifier, apollo, transition: state.transition }, scope);
  await runDraftStage({ db: baseDb, anthropic: draftAnthropic, telegram, getActiveSetting, transition: state.transition }, scope);
}

/** The operator taps Approve: the real Telegram handler path. */
async function approve(touchId: string): Promise<void> {
  await processTelegramUpdate(
    {
      db: baseDb,
      telegram,
      transition: state.transition,
      getActiveSetting,
      writeNewVersion: async () => {
        throw new Error("not expected");
      },
    },
    {
      update_id: 9_000_000_000 + Math.floor(Math.random() * 1_000_000),
      callback_query: {
        id: `${TAG}.cb`,
        from: { id: APPROVER },
        data: `approve:${touchId}`,
        message: { message_id: 1, chat: { id: APPROVER }, text: "card" },
      },
    },
    { skipStore: true },
  );
}

/** Stages → approve. Returns the approved touch id, or null if the lead stopped earlier. */
async function toApproved(f: Fixture): Promise<string | null> {
  await runStagesToApproval(f);
  const touch = await stepOneTouch(f.leadId);
  if (!touch || (await leadRow(f.leadId)).state !== "pending_approval") return null;
  await approve(touch.id);
  return (await leadRow(f.leadId)).state === "approved" ? touch.id : null;
}

async function queuedJob(kind: string, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await db
    .from("jobs")
    .insert({ type: `${TAG}.${kind}`, payload: payload as never, state: "queued", run_after: new Date(Date.now() + 30 * 86_400_000).toISOString() })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture job: ${error?.message}`);
  fixture.jobIds.push(data.id);
  return data.id;
}

async function jobState(id: string): Promise<string | null> {
  const { data } = await db.from("jobs").select("state").eq("id", id).maybeSingle();
  return data?.state ?? null;
}

// ---------------------------------------------------------------------------
// Happy path and the eight stop-rule siblings
// ---------------------------------------------------------------------------

async function happyPath(a: Account): Promise<void> {
  console.log("\n--- traversal: sourced → … → sent through the real stages ---");
  const f = await createSourcedLead("happy", a);
  const draftsBefore = mock.draftCalls;
  const touchId = await toApproved(f);
  assert("happy: real stages + Telegram approve reach approved", touchId !== null, (await leadRow(f.leadId)).state);
  if (!touchId) return;
  assert("happy: draft card sent to Telegram (mock) and one draft call", mock.telegram.includes("sendApproval") && mock.draftCalls === draftsBefore + 1);

  const enrollBefore = mock.enroll;
  const outcome = await runSendJob(sendDeps(INSIDE), jobCtx(touchId));
  const lead = await leadRow(f.leadId);
  const touch = await stepOneTouch(f.leadId);
  const { data: day } = await raw.from("capacity_ledger" as never).select("accepted").eq("send_account_id", a.id).maybeSingle();
  assert("happy: send outcome sent (enroll), exactly one enroll call", outcome.kind === "sent" && mock.enroll === enrollBefore + 1, JSON.stringify(outcome));
  assert("happy: lead state sent, touch sent, ledger accepted = 1", lead.state === "sent" && touch?.status === "sent" && (day as { accepted?: number } | null)?.accepted === 1, `${lead.state}/${touch?.status}/${JSON.stringify(day)}`);
  const path = await history(f.leadId);
  const expected: LeadState[] = ["enriching", "qualifying", "qualified", "verifying", "drafting", "pending_approval", "approved", "queued", "sent"];
  assert("happy: every hop recorded by lib/state, in order", JSON.stringify(path) === JSON.stringify(expected), path.join(" → "));
}

async function refusedWith(f: Fixture, touchId: string, reason: string, label: string): Promise<void> {
  const before = mock.enroll;
  const outcome = await runSendJob(sendDeps(INSIDE), jobCtx(touchId));
  const reasons: string[] = outcome.kind === "refused" ? outcome.verdicts.map((v) => v.reason) : [];
  assert(`${label}: send refused with ${reason}`, outcome.kind === "refused" && reasons.includes(reason), JSON.stringify(outcome.kind === "refused" ? reasons : outcome));
  assert(`${label}: zero enroll calls, lead never sent`, mock.enroll === before && (await leadRow(f.leadId)).state !== "sent");
}

async function sibling1NoEvidence(a: Account): Promise<void> {
  console.log("\n--- stop 1: no evidence → null hypothesis → parked at qualify ---");
  const f = await createSourcedLead("s1-noevidence", a);
  mock.qualify.set(f.domain, "no_evidence");
  const draftsBefore = mock.draftCalls;
  const touchId = await toApproved(f);
  const lead = await leadRow(f.leadId);
  const { data: q } = await db.from("qualification").select("problem_hypothesis").eq("lead_id", f.leadId).maybeSingle();
  assert("stop 1: lead parked at qualify, never qualified or drafted", touchId === null && lead.state === "parked" && !(await history(f.leadId)).includes("qualified"), lead.state);
  assert(
    // The column is not null; qualify stores an explicit marker, never a hypothesis.
    "stop 1: no hypothesis stored (only the disqualified marker), zero draft calls, no enroll beyond the happy path",
    q?.problem_hypothesis === "(disqualified: insufficient_evidence)" && mock.draftCalls === draftsBefore && mock.enroll === 1,
    JSON.stringify({ q, drafts: mock.draftCalls - draftsBefore, enroll: mock.enroll }),
  );
}

async function sibling2InvalidEmail(a: Account): Promise<void> {
  console.log("\n--- stop 2: MillionVerifier invalid → parked + suppression ---");
  const f = await createSourcedLead("s2-invalid", a);
  mock.invalidEmails.add(f.email);
  fixture.suppressionEmails.push(f.email);
  const touchId = await toApproved(f);
  const lead = await leadRow(f.leadId);
  const { data: rows } = await db.from("suppression_list").select("reason").ilike("email", f.email);
  assert("stop 2: parked at verify, email_status invalid, never drafted", touchId === null && lead.state === "parked" && lead.email_status === "invalid" && !(await history(f.leadId)).includes("drafting"), lead.state);
  assert("stop 2: suppression row written (invalid_email)", rows?.length === 1 && rows[0]!.reason === "invalid_email");
}

async function sibling3SuppressedEmail(a: Account): Promise<void> {
  console.log("\n--- stop 3: email suppressed after approval → suppressed_email ---");
  const f = await createSourcedLead("s3-suppressed", a);
  const touchId = await toApproved(f);
  if (!touchId) return assert("stop 3: reached approved", false);
  fixture.suppressionEmails.push(f.email);
  const { error } = await db.from("suppression_list").insert({ email: f.email.toUpperCase(), reason: "test_u6t_opt_out" });
  if (error) throw new Error(`suppression: ${error.message}`);
  await refusedWith(f, touchId, "suppressed_email", "stop 3");
}

async function sibling4SuppressedDomain(a: Account): Promise<void> {
  console.log("\n--- stop 4: company domain suppressed after approval → suppressed_domain ---");
  const f = await createSourcedLead("s4-domain", a);
  const touchId = await toApproved(f);
  if (!touchId) return assert("stop 4: reached approved", false);
  fixture.suppressionDomains.push(f.domain);
  const { error } = await db.from("suppression_list").insert({ domain: f.domain, reason: "test_u6t_company_optout" });
  if (error) throw new Error(`domain suppression: ${error.message}`);
  await refusedWith(f, touchId, "suppressed_domain", "stop 4");
}

async function sibling5ReplyBeforeSend(a: Account): Promise<void> {
  console.log("\n--- stop 5: a reply arrives before the send → job cancelled, reply_freeze ---");
  const f = await createSourcedLead("s5-reply", a);
  const touchId = await toApproved(f);
  if (!touchId) return assert("stop 5: reached approved", false);
  const touch = await stepOneTouch(f.leadId);
  const { job } = await enqueueSend({ queue }, { id: touchId, approval_hash: touch!.approval_hash });
  fixture.jobIds.push(job.id);
  const draftsBefore = mock.draftCalls + mock.qualifyCalls;
  const res = await postWebhook({
    event_type: "reply_received",
    timestamp: new Date().toISOString(),
    campaign_id: a.campaign,
    email_account: a.identifier,
    lead_email: f.email,
    email_id: `${TAG}.s5.reply`,
    reply_subject: "Re: earlier note",
    reply_text: "We spoke last week — please call me.",
  });
  assert("stop 5: webhook processed, the queued send job cancelled before any model call", res.status === 200 && (await jobState(job.id)) === "cancelled" && mock.draftCalls + mock.qualifyCalls === draftsBefore, `${res.status} ${await jobState(job.id)}`);
  // A worker that had already leased the job is stopped by preflight.
  await refusedWith(f, touchId, "reply_freeze", "stop 5");
}

async function sibling6Unsubscribe(a: Account): Promise<void> {
  console.log("\n--- stop 6: unsubscribe → suppressed, email + linkedin_msg jobs cancelled ---");
  const f = await createSourcedLead("s6-unsub", a);
  const touchId = await toApproved(f);
  if (!touchId) return assert("stop 6: reached approved", false);
  fixture.suppressionEmails.push(f.email);
  const touch = await stepOneTouch(f.leadId);
  const { job } = await enqueueSend({ queue }, { id: touchId, approval_hash: touch!.approval_hash });
  fixture.jobIds.push(job.id);
  const li = await queuedJob("linkedin_msg", { lead_id: f.leadId, channel: "linkedin_msg" });
  const res = await postWebhook({
    event_type: "lead_unsubscribed",
    timestamp: new Date().toISOString(),
    campaign_id: a.campaign,
    email_account: a.identifier,
    lead_email: f.email,
  });
  const lead = await leadRow(f.leadId);
  assert(
    "stop 6: lead suppressed + do_not_contact; email job AND linkedin_msg job cancelled",
    res.status === 200 && lead.state === "suppressed" && lead.do_not_contact === true && (await jobState(job.id)) === "cancelled" && (await jobState(li)) === "cancelled",
    `${lead.state} ${await jobState(job.id)} ${await jobState(li)}`,
  );
  await refusedWith(f, touchId, "suppressed_email", "stop 6");
}

async function sibling7Booked(a: Account): Promise<void> {
  console.log("\n--- stop 7: meeting booked → booking_hold ---");
  const f = await createSourcedLead("s7-booked", a);
  const touchId = await toApproved(f);
  if (!touchId) return assert("stop 7: reached approved", false);
  // Calendly is U8; until then the fixture reaches meeting_booked via manual_hold.
  await state.transition(f.leadId, "approved", "manual_hold", "test_u6t_fixture", { tag: TAG });
  await state.transition(f.leadId, "manual_hold", "meeting_booked", "test_u6t_fixture", { tag: TAG });
  await refusedWith(f, touchId, "booking_hold", "stop 7");
}

async function sibling8StalePause(): Promise<void> {
  console.log("\n--- stop 8: stop_processing_stale pauses the sender → zero Instantly calls ---");
  const s = await createAccount("stale");
  // An earlier send on this sender, accepted 26h ago, with no webhook since.
  const older = await createSourcedLead("s8-older", s);
  await walk(older, "sent");
  await insertSentTouch(older.leadId, s.id, 26);

  const f = await createSourcedLead("s8-stale", s);
  const touchId = await toApproved(f);
  if (!touchId) return assert("stop 8: reached approved", false);

  const result = await runStaleStopCheck(reconcileDeps(), { sendAccountIds: [s.id] });
  const { data: account } = await db.from("send_accounts").select("health, paused_reason").eq("id", s.id).single();
  const { data: exc } = await db.from("exceptions").select("status").eq("kind", "stop_processing_stale").eq("detail->>send_account_id", s.id);
  assert(
    "stop 8: stale check paused the sender (engine health + Instantly campaign) and escalated",
    result.senders[0]?.verdict === "paused" && account?.health === "paused" && /stop_processing_stale/.test(account.paused_reason ?? "") && mock.paused.includes(s.campaign) && exc?.length === 1 && exc[0]!.status === "escalated",
    JSON.stringify({ result, account, exc }),
  );
  assert("stop 8: operator alerted once for the pause", mock.alerts.filter((t) => t.includes("stop_processing_stale") && t.includes(s.identifier)).length === 1);

  const callsBefore = mock.instantly.length;
  await refusedWith(f, touchId, "sender_unhealthy", "stop 8");
  assert("stop 8: the send made ZERO Instantly calls of any kind", mock.instantly.length === callsBefore, mock.instantly.slice(callsBefore).join(","));
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

/** Walks a fixture lead through lib/state (reconcile fixtures need no stage run), with its revealed email. */
async function walk(f: Fixture, until: LeadState): Promise<void> {
  const { error } = await db.from("leads").update({ email: f.email, email_status: "valid" }).eq("id", f.leadId);
  if (error) throw new Error(`fixture email: ${error.message}`);
  for (const [from, to] of PATH_TO_SENT) {
    await state.transition(f.leadId, from, to, "test_u6t_fixture", { tag: TAG });
    if (to === until) break;
  }
}

async function insertSentTouch(leadId: string, accountId: string, hoursAgo: number): Promise<string> {
  const { data, error } = await db
    .from("touches")
    .insert({
      lead_id: leadId,
      step_no: 1,
      channel: "email",
      direction: "outbound",
      status: "sent",
      subject: "Evening quote requests",
      body: "Hi Tess,\n\nA specific observation.",
      send_account_id: accountId,
      sent_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture touch: ${error?.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

async function insertWebhookRow(campaign: string, extra: Record<string, unknown> = {}): Promise<void> {
  const { data, error } = await db
    .from("webhook_events")
    .insert({
      provider: "instantly",
      external_id: `${TAG}.${randomUUID()}`,
      event_type: "email_opened",
      payload: { event_type: "email_opened", campaign_id: campaign, lead_email: `x@${TAG}.example.invalid`, ...extra } as never,
      processed: true,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture webhook_event: ${error?.message}`);
  fixture.eventIds.push(data.id);
}

async function staleCases(): Promise<void> {
  console.log("\n--- reconcile: stale detection boundaries ---");
  const fresh = await createAccount("fresh");
  const fl = await createSourcedLead("r-fresh", fresh);
  await walk(fl, "sent");
  await insertSentTouch(fl.leadId, fresh.id, 26);
  await insertWebhookRow(fresh.campaign); // a real delivery since the send

  const polled = await createAccount("polled");
  const pl = await createSourcedLead("r-polled", polled);
  await walk(pl, "sent");
  await insertSentTouch(pl.leadId, polled.id, 26);
  await insertWebhookRow(polled.campaign, { source: POLL_SOURCE }); // only a poll-sourced row

  const young = await createAccount("young");
  const yl = await createSourcedLead("r-young", young);
  await walk(yl, "sent");
  await insertSentTouch(yl.leadId, young.id, 3); // not 25h old yet

  const pausedBefore = mock.paused.length;
  const r = await runStaleStopCheck(reconcileDeps(), { sendAccountIds: [fresh.id, polled.id, young.id] });
  const verdict = (id: string) => r.senders.find((x) => x.send_account_id === id)?.verdict;
  assert("stale: a webhook event since the send → ok, not paused", verdict(fresh.id) === "ok");
  assert("stale: a poll-sourced row does NOT count as webhook activity → paused", verdict(polled.id) === "paused" && mock.paused.length === pausedBefore + 1);
  assert("stale: a send younger than 25h → no_aged_sends", verdict(young.id) === "no_aged_sends");
  const again = await runStaleStopCheck(reconcileDeps(), { sendAccountIds: [polled.id] });
  assert("stale: idempotent — an already-paused sender is not re-paused", again.senders.length === 0 && mock.paused.length === pausedBefore + 1);
}

async function pollCases(): Promise<void> {
  console.log("\n--- reconcile: missed-reply poll through the webhook processor ---");
  const p = await createAccount("poll");

  // Lead 1: reply missed by the webhook, found by the poll.
  const l1 = await createSourcedLead("r-poll1", p);
  await walk(l1, "sent");
  const sent1 = await insertSentTouch(l1.leadId, p.id, 30);
  const job1 = await queuedJob("send.email", { touch_id: sent1, lead_id: l1.leadId });
  // Lead 2: reply seen by the webhook first; the poll must not re-apply it.
  const l2 = await createSourcedLead("r-poll2", p);
  await walk(l2, "sent");
  await insertSentTouch(l2.leadId, p.id, 20);
  const r2 = await postWebhook({
    event_type: "reply_received",
    timestamp: new Date().toISOString(),
    campaign_id: p.campaign,
    email_account: p.identifier,
    lead_email: l2.email,
    email_id: `${TAG}.e2`,
    reply_subject: "Re: Evening quote requests",
    reply_text: "Not now, thanks.",
  });
  assert("poll setup: lead 2 replied via webhook", r2.status === 200 && (await leadRow(l2.leadId)).state === "replied");
  // Lead 3: an auto-reply the poll sees twice.
  const l3 = await createSourcedLead("r-poll3", p);
  await walk(l3, "sent");
  await insertSentTouch(l3.leadId, p.id, 10);

  mock.inbox.set(p.identifier, [
    syntheticEmail({ id: `${TAG}.e1`, eaccount: p.identifier, lead: l1.email, campaign_id: p.campaign, body: { text: "Yes, tell me more." }, is_auto_reply: 0, timestamp_email: new Date().toISOString() }),
    syntheticEmail({ id: `${TAG}.e2`, eaccount: p.identifier, lead: l2.email, campaign_id: p.campaign, body: { text: "Not now, thanks." }, is_auto_reply: 0 }),
    syntheticEmail({ id: `${TAG}.e3`, eaccount: p.identifier, lead: l3.email, campaign_id: p.campaign, subject: "Automatic reply: Evening quote requests", body: { text: "Out of office until October 12." }, is_auto_reply: 1, timestamp_email: "2026-09-24T10:00:00.000Z" }),
    syntheticEmail({ id: `${TAG}.e4`, eaccount: p.identifier, lead: "someone@legacy-campaign.example.invalid", body: { text: "hello" } }),
  ]);

  const modelCalls = mock.qualifyCalls + mock.draftCalls;
  const events2Before = (await db.from("lead_events").select("id").eq("lead_id", l2.leadId)).data?.length ?? 0;
  const s1 = await runReplyPoll(reconcileDeps(), { sendAccountIds: [p.id] });
  const call = mock.listEmails.at(-1) ?? {};
  const lead1 = await leadRow(l1.leadId);
  const { data: inbound } = await db.from("touches").select("id").eq("lead_id", l1.leadId).eq("direction", "inbound");
  assert(
    "poll: GET /emails with email_type=received, this sender, window from the oldest awaiting send, asc",
    call.emailType === "received" && call.eaccount === p.identifier && call.sortOrder === "asc" && typeof call.minTimestampCreated === "string" && Date.parse(String(call.minTimestampCreated)) <= Date.now() - 29 * 3_600_000,
    JSON.stringify(call),
  );
  assert("poll: missed reply → lead 1 sent → replied, inbound touch, queued job cancelled", lead1.state === "replied" && inbound?.length === 1 && (await jobState(job1)) === "cancelled", `${lead1.state} ${inbound?.length} ${await jobState(job1)}`);
  assert("poll: no model call (freeze before classification) and no network", mock.qualifyCalls + mock.draftCalls === modelCalls && network.length === 0);
  const { data: polledRow } = await db.from("webhook_events").select("id, payload").eq("provider", "instantly").eq("payload->>email_id", `${TAG}.e1`);
  assert("poll: the reply went through webhook_events marked source=reconcile_poll", polledRow?.length === 1 && (polledRow[0]!.payload as Record<string, unknown>).source === POLL_SOURCE);
  const events2After = (await db.from("lead_events").select("id").eq("lead_id", l2.leadId)).data?.length ?? 0;
  assert("poll: reply already applied by the webhook → already_seen, no second lead_events row", s1.already_seen === 1 && events2After === events2Before, JSON.stringify(s1));
  assert("poll: unmatched received email ignored, no exception", s1.ignored_unmatched === 1 && (await db.from("exceptions").select("id").eq("lead_id", l1.leadId)).data?.length === 0);
  assert("poll: auto-reply recorded only (lead 3 stays sent)", s1.outcomes.auto_reply_recorded === 1 && (await leadRow(l3.leadId)).state === "sent", JSON.stringify(s1.outcomes));

  // Now the webhook for lead 1's reply arrives late: dedupe by email id.
  const events1Before = (await db.from("lead_events").select("id").eq("lead_id", l1.leadId)).data?.length ?? 0;
  const late = await postWebhook({
    event_type: "reply_received",
    timestamp: new Date().toISOString(),
    campaign_id: p.campaign,
    email_account: p.identifier,
    lead_email: l1.email,
    email_id: `${TAG}.e1`,
    reply_subject: "Re: Evening quote requests",
    reply_text: "Yes, tell me more.",
  });
  const events1After = (await db.from("lead_events").select("id").eq("lead_id", l1.leadId)).data?.length ?? 0;
  const { data: inboundAfter } = await db.from("touches").select("id").eq("lead_id", l1.leadId).eq("direction", "inbound");
  assert("poll→webhook: late webhook → duplicate_reply, no second lead_events row, one inbound touch", late.body.action === "duplicate_reply" && events1After === events1Before && inboundAfter?.length === 1, JSON.stringify(late.body));

  // A second poll changes nothing: replies already_seen, the auto-reply deduped.
  const s2 = await runReplyPoll(reconcileDeps(), { sendAccountIds: [p.id] });
  const autoEvents = (await db.from("lead_events").select("id").eq("lead_id", l3.leadId).eq("event", "auto_reply")).data?.length ?? 0;
  assert("poll: second run → both replies already_seen, auto-reply deduped (one auto_reply event)", s2.already_seen === 2 && autoEvents === 1 && !s2.outcomes.reply_frozen, JSON.stringify(s2));
}

async function truncationCases(): Promise<void> {
  console.log("\n--- reconcile: truncation (429, page cap) and the two-in-a-row escalation ---");
  const { data: existing } = await db.from("exceptions").select("id").eq("kind", "reply_poll_truncated").neq("status", "resolved");
  if ((existing ?? []).length > 0) {
    skip("truncation cases", "an unresolved reply_poll_truncated exception already exists in the live DB — not touched");
    return;
  }
  const t = await createAccount("trunc");
  const tl = await createSourcedLead("r-trunc", t);
  await walk(tl, "sent");
  await insertSentTouch(tl.leadId, t.id, 5);

  mock.rateLimited = true;
  const alertsBefore = mock.alerts.length;
  const r1 = await runReplyPoll(reconcileDeps(), { sendAccountIds: [t.id] });
  const open1 = (await db.from("exceptions").select("status").eq("kind", "reply_poll_truncated").neq("status", "resolved")).data ?? [];
  assert("429: run ends truncated (rate_limited), one open exception, no alert yet", r1.truncated && r1.truncated_reason === "rate_limited" && open1.length === 1 && open1[0]!.status === "open" && mock.alerts.length === alertsBefore, JSON.stringify(r1));
  const r2 = await runReplyPoll(reconcileDeps(), { sendAccountIds: [t.id] });
  const open2 = (await db.from("exceptions").select("status").eq("kind", "reply_poll_truncated").neq("status", "resolved")).data ?? [];
  assert("429 again: escalated, operator alerted exactly once", r2.truncated && open2.length === 1 && open2[0]!.status === "escalated" && mock.alerts.length === alertsBefore + 1);
  mock.rateLimited = false;

  mock.endlessPages = true;
  const r3 = await runReplyPoll(reconcileDeps(), { sendAccountIds: [t.id] });
  assert("page cap: 3 pages for one sender, then truncated (page_cap)", r3.truncated && r3.truncated_reason === "page_cap" && r3.requests === 3 && r3.ignored_unmatched === 300, JSON.stringify(r3));
  mock.endlessPages = false;

  const r4 = await runReplyPoll(reconcileDeps(), { sendAccountIds: [t.id] });
  const open4 = (await db.from("exceptions").select("id").eq("kind", "reply_poll_truncated").neq("status", "resolved")).data ?? [];
  assert("complete run → the truncation exception is resolved", !r4.truncated && open4.length === 0 && mock.alerts.length === alertsBefore + 1);
}

// ---------------------------------------------------------------------------
// Counts, cleanup
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
  "outbox",
  "enrichment_payloads",
  "qualification",
  "qualification_history",
  "sequences",
  "capacity_ledger",
  "capacity_reservations",
] as const;

async function count(table: string): Promise<number> {
  const { count: n, error } = await raw.from(table as never).select("*", { count: "exact", head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return n ?? 0;
}

async function realSnapshot(): Promise<string> {
  const { data: leads } = await db.from("leads").select("id, state, email_status, do_not_contact").order("id");
  const { data: accounts } = await db.from("send_accounts").select("id, health, paused_reason").order("id");
  const real = (leads ?? []).filter((l) => !fixture.leadIds.includes(l.id));
  const realAccounts = (accounts ?? []).filter((a) => !fixture.accountIds.includes(a.id));
  return JSON.stringify({ real, realAccounts });
}

async function cleanup(): Promise<void> {
  const del = async (label: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await run();
    if (error) console.error(`cleanup ${label}: ${error.message}`);
  };
  const { data: tagged } = await db.from("webhook_events").select("id").eq("provider", "instantly").like("payload->>lead_email", `%${TAG}%`);
  const { data: taggedCampaign } = await db.from("webhook_events").select("id").eq("provider", "instantly").like("payload->>campaign_id", `${TAG}%`);
  const eventIds = [...new Set([...fixture.eventIds, ...(tagged ?? []).map((r) => r.id), ...(taggedCampaign ?? []).map((r) => r.id)])];
  if (eventIds.length) await del("exceptions(event)", () => db.from("exceptions").delete().in("webhook_event_id", eventIds));
  if (fixture.leadIds.length) await del("exceptions(lead)", () => db.from("exceptions").delete().in("lead_id", fixture.leadIds));
  for (const id of fixture.accountIds) {
    await del("exceptions(sender)", () => db.from("exceptions").delete().eq("detail->>send_account_id", id));
  }
  await del("exceptions(truncated)", () =>
    db.from("exceptions").delete().eq("kind", "reply_poll_truncated").gte("created_at", START.toISOString()),
  );
  if (eventIds.length) await del("webhook_events", () => db.from("webhook_events").delete().in("id", eventIds));

  const { data: touches } = fixture.leadIds.length ? await db.from("touches").select("id").in("lead_id", fixture.leadIds) : { data: [] };
  const touchIds = (touches ?? []).map((t) => t.id);
  if (touchIds.length) await del("jobs(send)", () => db.from("jobs").delete().in("payload->>touch_id", touchIds));
  if (fixture.jobIds.length) await del("jobs(ids)", () => db.from("jobs").delete().in("id", fixture.jobIds));
  await del("jobs(type)", () => db.from("jobs").delete().like("type", `${TAG}.%`));

  for (const email of fixture.suppressionEmails) {
    await del("suppression", () => db.from("suppression_list").delete().ilike("email", email));
  }
  for (const domain of fixture.suppressionDomains) {
    await del("suppression(domain)", () => db.from("suppression_list").delete().eq("domain", domain));
  }
  if (fixture.leadIds.length) {
    await del("outbox", () => sendDb.from("outbox").delete().in("lead_id", fixture.leadIds));
    await del("touches", () => db.from("touches").delete().in("lead_id", fixture.leadIds));
    await del("lead_events", () => db.from("lead_events").delete().in("lead_id", fixture.leadIds));
    await del("qualification_history", () => baseDb.from("qualification_history").delete().in("lead_id", fixture.leadIds));
    await del("qualification", () => baseDb.from("qualification").delete().in("lead_id", fixture.leadIds));
    await del("enrichment_payloads", () => baseDb.from("enrichment_payloads").delete().in("lead_id", fixture.leadIds));
    await del("leads", () => db.from("leads").delete().in("id", fixture.leadIds));
  }
  if (fixture.companyIds.length) {
    await del("enrichment_payloads(company)", () => baseDb.from("enrichment_payloads").delete().in("company_id", fixture.companyIds));
    await del("companies", () => db.from("companies").delete().in("id", fixture.companyIds));
  }
  if (fixture.accountIds.length) {
    await del("capacity_reservations", () => raw.from("capacity_reservations" as never).delete().in("send_account_id", fixture.accountIds));
    await del("capacity_ledger", () => raw.from("capacity_ledger" as never).delete().in("send_account_id", fixture.accountIds));
    await del("send_accounts", () => db.from("send_accounts").delete().in("id", fixture.accountIds));
  }
}

async function main(): Promise<void> {
  console.log(`\n=== test-u6-traversal (tag=${TAG}) ===`);
  if (!Number.isFinite(APPROVER)) {
    skip("all traversal checks", "TELEGRAM_ALLOWED_USER_IDS has no numeric id (the approve path needs one)");
  } else {
    const before: Record<string, number> = {};
    for (const t of TABLES) before[t] = await count(t);
    console.log(`BEFORE  ${TABLES.map((t) => `${t}=${before[t]}`).join(" ")}`);
    const snapshotBefore = await realSnapshot();
    guardFetch();
    try {
      const a = await createAccount("a");
      await happyPath(a);
      await sibling1NoEvidence(a);
      await sibling2InvalidEmail(a);
      await sibling3SuppressedEmail(a);
      await sibling4SuppressedDomain(a);
      await sibling5ReplyBeforeSend(a);
      await sibling6Unsubscribe(a);
      await sibling7Booked(a);
      await sibling8StalePause();
      await staleCases();
      await pollCases();
      await truncationCases();
      assert("the whole run made one enroll call (the happy path) and no network call", mock.enroll === 1 && network.length === 0, `${mock.enroll} · ${network.join(", ")}`);
    } catch (error) {
      assert("no unexpected exception", false, error instanceof Error ? `${error.name}: ${error.stack}` : String(error));
    } finally {
      globalThis.fetch = realFetch;
      assert("real leads and real senders untouched (state, email status, DNC, health)", (await realSnapshot()) === snapshotBefore);
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
  console.error("test-u6-traversal crashed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
