import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import {
  InstantlyUncertainOutcomeError,
  type EnrollLeadInput,
  type ListEmailsParams,
} from "../src/lib/integrations/instantly";
import type { InstantlyAccount, InstantlyCampaignDetail, InstantlyEmail } from "../src/lib/integrations/instantly-types";
import { createJobQueue } from "../src/lib/jobs/queue";
import type { JobContext } from "../src/lib/jobs/registry";
import { createCapacityLedger } from "../src/lib/scheduler/ledger";
import { ledgerDate } from "../src/lib/scheduler/windows";
import { approvalHash, buildApprovalSnapshot, composeOutboundBody } from "../src/lib/sending/approval";
import { engineTimings, instantlySequencePayload, type LiveCampaignStep } from "../src/lib/sending/campaign-sequence";
import {
  buildSequenceApprovalSnapshot,
  sequenceApprovalHash,
  type EmailSequence,
  type SequenceApprovalSnapshot,
} from "../src/lib/sending/sequence-approval";
import { capacity_defaults, send_policy, send_windows } from "../src/lib/settings/seed-content";
import {
  runReconcileJob,
  runSendJob,
  SEND_JOB_TYPE,
  type SendDeps,
} from "../src/lib/stages/send/core";
import { createStateStore } from "../src/lib/state/core";
import type { Database } from "../src/types/database";
import type {
  DatabaseWithCapacity,
  DatabaseWithEnrollments,
  DatabaseWithJobs,
  DatabaseWithSending,
  DatabaseWithWebhooks,
} from "../src/types/database-extensions";
import type { LeadState } from "../src/types/enums";

// U5 DoD against Supabase (09 §U5). Every row it touches is a synthetic
// fixture tagged with TAG; the Instantly adapter is a counting mock, so no
// provider is called and nothing is sent. Lead states move only through
// lib/state (transition), never by writing leads.state.
//
// 09 §U6c S20: step 1 is enrolled as one approved 3-step sequence (the
// follow-ups are Instantly campaign steps), so every fixture is a sequence
// approval, and the U6c enroll DoD rows E1–E6 run here too.

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const raw = createServiceClient(url, key);
const db = raw as unknown as SupabaseClient<DatabaseWithSending>;
const exceptionsDb = raw as unknown as SupabaseClient<DatabaseWithWebhooks>;
const enrollDb = raw as unknown as SupabaseClient<DatabaseWithEnrollments>;
const ledger = createCapacityLedger(raw as unknown as SupabaseClient<DatabaseWithCapacity>);
const queue = createJobQueue(raw as unknown as SupabaseClient<DatabaseWithJobs>);
const state = createStateStore(raw as SupabaseClient<Database>);

// ---------------------------------------------------------------------------
// Harness (same shape as test-u2 / test-u3)
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
const TAG = `test.u5.${STAMP}`;
// Synthetic mailboxes on the two allowed domains. The local part is unique to
// this run; the mock adapter means nothing is ever sent from them.
const SENDER_A = `u5-${STAMP}-amir@zyndixhq.com`;
const SENDER_B = `u5-${STAMP}-amir@getzyndix.com`;

// Tue 2026-09-29 09:00 Europe/Vilnius — inside the priority window.
const INSIDE = new Date("2026-09-29T06:00:00.000Z");
// Sat 2026-10-03 — no window.
const WEEKEND = new Date("2026-10-03T09:00:00.000Z");
const TODAY = ledgerDate(INSIDE);

/** email_sequence v1 (0/7/7 days), served by the mocked settings as version 1. */
const EMAIL_SEQUENCE: EmailSequence = {
  steps: [
    { step_no: 1, delay: 0, delay_unit: "days", source: "writer" },
    { step_no: 2, delay: 7, delay_unit: "days", source: "writer" },
    { step_no: 3, delay: 7, delay_unit: "days", source: "template" },
  ],
};
const MATCHING_CAMPAIGN_STEPS = (): LiveCampaignStep[] => instantlySequencePayload(engineTimings(EMAIL_SEQUENCE))[0]!.steps;
const STEP_BODIES = {
  1: "Hi Test,\n\nA specific observation.\n\nWant the three?",
  2: "A different observation, from another evidence item.",
  3: "Hi Test,\n\nI haven't heard back, so I'll leave it here.",
} as const;

const fixture = {
  accountIds: [] as string[],
  companyIds: [] as string[],
  leadIds: [] as string[],
  touchIds: [] as string[],
  suppressionEmails: [] as string[],
  jobIds: [] as string[],
};

// ---------------------------------------------------------------------------
// Mock Instantly
// ---------------------------------------------------------------------------

type Mock = {
  enroll: EnrollLeadInput[];
  listEmails: ListEmailsParams[];
  findLead: Array<{ campaignId: string; email: string }>;
  /** getAccount + getWarmupAnalytics reads (Session 13: a paused sender makes none). */
  health: string[];
  enrollBehaviour: "created" | "uncertain" | "already";
  findLeadResult: boolean;
  /** 09 §U6c S20: the live campaign's steps (null = unreadable), and Instantly's daily budget. */
  campaignSteps: LiveCampaignStep[] | null;
  dailyLimit: number;
  sentToday: number;
  lastLeadId: string | null;
  alerts: string[];
};

const mock: Mock = {
  enroll: [],
  listEmails: [],
  findLead: [],
  health: [],
  enrollBehaviour: "created",
  findLeadResult: true,
  campaignSteps: MATCHING_CAMPAIGN_STEPS(),
  dailyLimit: 50,
  sentToday: 0,
  lastLeadId: null,
  alerts: [],
};

function healthyAccount(email: string): InstantlyAccount {
  return {
    email,
    timestamp_created: "2026-09-24T09:00:00.000Z",
    status: 1,
    warmup_status: 1,
    provider_code: 2,
    setup_pending: false,
    stat_warmup_score: 100,
    daily_limit: mock.dailyLimit,
  } as InstantlyAccount;
}

const settings: Record<string, unknown> = {
  send_policy,
  send_windows,
  capacity_defaults,
  email_sequence: EMAIL_SEQUENCE,
};

function deps(now: Date, hooks?: SendDeps["hooks"]): SendDeps {
  return {
    db,
    instantly: {
      async enrollLead(input) {
        mock.enroll.push(input);
        if (mock.enrollBehaviour === "uncertain") {
          throw new InstantlyUncertainOutcomeError(
            "mock: timed out after dispatch",
            { op: "enrollLead", method: "POST", path: "/api/v2/leads/add", status: null },
            "timeout_after_dispatch",
            { campaignId: input.campaignId, email: input.lead.email },
          );
        }
        if (mock.enrollBehaviour === "already") {
          return { outcome: "skipped", reason: "already_enrolled", raw: {} as never };
        }
        mock.lastLeadId = randomUUID();
        return { outcome: "created", leadId: mock.lastLeadId, raw: {} as never };
      },
      async getCampaign(id) {
        mock.health.push(`getCampaign:${id}`);
        if (mock.campaignSteps === null) throw new Error("mock: campaign unreadable");
        return {
          id,
          name: "mock",
          status: 1,
          timestamp_created: now.toISOString(),
          sequences: [{ steps: mock.campaignSteps }],
        } as InstantlyCampaignDetail;
      },
      async getAccountDailyAnalytics(params) {
        mock.health.push(`getAccountDailyAnalytics:${params.emails.join(",")}`);
        return params.emails.map((email) => ({ date: params.startDate, email_account: email, sent: mock.sentToday }));
      },
      async getAccount(email) {
        mock.health.push(`getAccount:${email}`);
        return healthyAccount(email);
      },
      async getWarmupAnalytics(emails) {
        mock.health.push(`getWarmupAnalytics:${emails.join(",")}`);
        return { aggregate_data: Object.fromEntries(emails.map((e) => [e, { health_score: 100 }])) };
      },
      async findLeadInCampaign(campaignId, email) {
        mock.findLead.push({ campaignId, email });
        return mock.findLeadResult
          ? { id: randomUUID(), email, status: 1, timestamp_created: now.toISOString() }
          : null;
      },
      async listEmails(params) {
        mock.listEmails.push(params ?? {});
        return { items: [] as InstantlyEmail[], truncated: false };
      },
    },
    ledger,
    queue,
    transition: state.transition,
    getActiveSetting: async (k) => {
      if (!(k in settings)) throw new Error(`No active setting found for key "${k}"`);
      return { version: 1, value: settings[k] };
    },
    alert: async (text) => {
      mock.alerts.push(text);
    },
    now: () => now,
    rng: () => 0.5,
    hooks,
  };
}

function jobCtx(touchId: string, id = randomUUID()): JobContext<{ touch_id: string }> {
  return { id, type: SEND_JOB_TYPE, payload: { touch_id: touchId }, attempt: 1, maxAttempts: 5, idempotencyKey: null };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Synthetic plain-text signature for a fixture mailbox (0009, Session 12). */
const fixtureSignature = (identifier: string): string => `Test ${identifier.split("@")[0]}\nZyndix, Vilnius\nzyndix.com`;

async function createAccount(identifier: string, campaign: string): Promise<string> {
  const { data, error } = await db
    .from("send_accounts")
    .insert({
      kind: "email",
      identifier,
      domain: identifier.split("@")[1],
      provider: "test",
      health: "ok",
      ramp_started_on: "2026-09-01",
      instantly_campaign_id: `${TAG}.${campaign}`,
      signature_text: fixtureSignature(identifier),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture account: ${error?.message}`);
  fixture.accountIds.push(data.id);
  return data.id;
}

type LeadFixture = { leadId: string; companyId: string; email: string };

async function createLead(
  n: string,
  opts: { country?: string | null; leadTimezone?: string | null } = {},
): Promise<LeadFixture> {
  const domain = `${n}.${TAG}.example.invalid`;
  const { data: company, error: companyError } = await db
    .from("companies")
    .insert({
      name: `U5 Fixture ${n}`,
      domain,
      country: opts.country === undefined ? "LT" : opts.country,
      timezone: null,
      segment: "test",
    })
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
      email_verified_at: "2026-09-20T00:00:00.000Z",
      timezone: opts.leadTimezone === undefined ? "Europe/Vilnius" : opts.leadTimezone,
      state: "sourced",
    })
    .select("id")
    .single();
  if (leadError || !lead) throw new Error(`fixture lead: ${leadError?.message}`);
  fixture.leadIds.push(lead.id);

  const path: Array<[LeadState, LeadState]> = [
    ["sourced", "enriching"],
    ["enriching", "qualifying"],
    ["qualifying", "qualified"],
    ["qualified", "verifying"],
    ["verifying", "drafting"],
    ["drafting", "pending_approval"],
  ];
  for (const [from, to] of path) {
    await state.transition(lead.id, from, to, "test_u5_fixture", { tag: TAG });
  }
  return { leadId: lead.id, companyId: company.id, email };
}

type SequenceFixture = { stepOne: string; stepTwo: string; stepThree: string; hash: string; snapshot: SequenceApprovalSnapshot };
const sequences = new Map<string, SequenceFixture>();

/**
 * A lead's whole 3-step sequence, approved with a real sequence binding (what
 * the Telegram handler writes through approve_email_sequence, 09 §U6c): one
 * hash over every step on every touch. Returns step 1's touch id; the other
 * ids are in `sequences`. `legacySingle` approves step 1 alone with the
 * pre-U6c single-touch snapshot; `bodies` overrides step texts as approved.
 */
async function createApprovedTouch(
  f: LeadFixture,
  opts: {
    sendAccountId?: string | null;
    transitionLead?: boolean;
    legacySingle?: boolean;
    bodies?: Partial<Record<1 | 2 | 3, string>>;
  } = {},
): Promise<string> {
  const { data: rows, error } = await db
    .from("touches")
    .insert(
      ([1, 2, 3] as const).map((step) => ({
        lead_id: f.leadId,
        step_no: step,
        channel: "email",
        direction: "outbound",
        status: "pending_approval",
        subject: step === 1 ? "Your listing pages" : null,
        draft_body: opts.bodies?.[step] ?? STEP_BODIES[step],
        body: null,
        prompt_version: 10,
        send_account_id: opts.sendAccountId ?? null,
      })),
    )
    .select("id, step_no, channel, subject, draft_body, prompt_version");
  if (error || !rows || rows.length !== 3) throw new Error(`fixture touches: ${error?.message}`);
  fixture.touchIds.push(...rows.map((r) => r.id));
  const touches = [...rows].sort((a, b) => (a.step_no ?? 0) - (b.step_no ?? 0)).map((t) => ({ ...t, body: t.draft_body }));

  // The sender is fixed at approval (Session 12): the given account, else the
  // lead's binding — what the Telegram handler does.
  const senderId = opts.sendAccountId ?? (await leadRow(f.leadId)).send_account_id;
  const { data: sender } = senderId
    ? await db.from("send_accounts").select("id, signature_text, instantly_campaign_id").eq("id", senderId).single()
    : { data: null };

  if (opts.legacySingle) {
    const single = buildApprovalSnapshot(touches[0]!, { id: f.leadId, email: f.email }, sender);
    await approveRows([touches[0]!.id], touches, senderId, approvalHash(single), single);
    if (opts.transitionLead !== false) {
      await state.transition(f.leadId, "pending_approval", "approved", "approved", { touch_id: touches[0]!.id, source: "test" });
    }
    return touches[0]!.id;
  }

  const snapshot = buildSequenceApprovalSnapshot({
    lead: { id: f.leadId, email: f.email },
    sender: sender ?? { id: "", signature_text: null, instantly_campaign_id: null },
    sequence: { version: 1, value: EMAIL_SEQUENCE },
    touches,
  });
  const hash = sequenceApprovalHash(snapshot);
  await approveRows(touches.map((t) => t.id), touches, senderId, hash, snapshot);
  if (opts.transitionLead !== false) {
    await state.transition(f.leadId, "pending_approval", "approved", "approved", { touch_id: touches[0]!.id, source: "test" });
  }
  sequences.set(touches[0]!.id, { stepOne: touches[0]!.id, stepTwo: touches[1]!.id, stepThree: touches[2]!.id, hash, snapshot });
  return touches[0]!.id;
}

async function approveRows(
  ids: string[],
  touches: Array<{ id: string; body: string | null }>,
  senderId: string | null,
  hash: string,
  snapshot: unknown,
): Promise<void> {
  for (const id of ids) {
    const { error } = await db
      .from("touches")
      .update({
        body: touches.find((t) => t.id === id)!.body,
        send_account_id: senderId,
        status: "approved",
        approval_hash: hash,
        approval_snapshot: snapshot as never,
        approved_at: new Date().toISOString(),
        approved_by: "test:u5",
      })
      .eq("id", id);
    if (error) throw new Error(`fixture approve: ${error.message}`);
  }
}

async function leadRow(leadId: string) {
  const { data } = await db.from("leads").select("state, send_account_id").eq("id", leadId).single();
  return data!;
}

async function outboxFor(touchId: string) {
  const { data } = await db.from("outbox").select("*").eq("touch_id", touchId);
  return data ?? [];
}

async function ledgerDay(accountId: string) {
  return ledger.getDay(accountId, TODAY);
}

async function reservationCount(accountId: string): Promise<number> {
  const { count } = await db
    .from("capacity_reservations")
    .select("id", { count: "exact", head: true })
    .eq("send_account_id", accountId);
  return count ?? 0;
}

async function events(leadId: string, event: string) {
  const { data } = await db.from("lead_events").select("event, detail").eq("lead_id", leadId).eq("event", event);
  return data ?? [];
}

async function jobsForTouch(touchId: string): Promise<number> {
  const { count } = await db
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .like("idempotency_key", `send:${touchId}:%`);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function happyPathAndPinning(accountA: string, accountB: string): Promise<void> {
  console.log("\n--- DoD: happy path (approved → queued → sent) ---");
  const f = await createLead("happy");
  const touch = await createApprovedTouch(f, { sendAccountId: accountA });
  const enrollBefore = mock.enroll.length;
  const job = jobCtx(touch);
  const outcome = await runSendJob(deps(INSIDE), job);
  const lead = await leadRow(f.leadId);
  const day = await ledgerDay(accountA);
  const [ob] = await outboxFor(touch);
  assert("happy: outcome sent (enroll)", outcome.kind === "sent" && outcome.operation === "enroll", JSON.stringify(outcome));
  assert("happy: adapter called exactly once", mock.enroll.length - enrollBefore === 1, `${mock.enroll.length - enrollBefore}`);
  assert("happy: lead approved → sent", lead.state === "sent", lead.state);
  assert("happy: ledger accepted = 1", day?.accepted === 1, JSON.stringify(day));
  assert("happy: reserved back to 0, used = 1", day?.reserved === 0 && day?.used === 1);
  assert("happy: first touch binds the send_account", lead.send_account_id === accountA);
  assert("happy: outbox accepted with a provider lead id", ob?.state === "accepted" && Boolean(ob?.provider_lead_id));
  const enrolled = mock.enroll[mock.enroll.length - 1];
  assert(
    "happy: enrolled into the bound account's campaign with the approved subject/body as variables",
    enrolled.campaignId === `${TAG}.camp-A` &&
      enrolled.lead.custom_variables?.zx_subject === "Your listing pages" &&
      String(enrolled.lead.custom_variables?.zx_body).includes("<br/>"),
  );
  assert(
    "happy: step 1 body ends with the bound mailbox's signature (Session 12)",
    String(enrolled.lead.custom_variables?.zx_body).endsWith(`Want the three?<br/><br/>${fixtureSignature(SENDER_A).replace(/\n/g, "<br/>")}`),
    String(enrolled.lead.custom_variables?.zx_body).slice(-80),
  );
  const queuedEvents = await events(f.leadId, "send_queued");
  const qd = queuedEvents[0]?.detail as Record<string, unknown> | undefined;
  assert("happy: send_queued event names the lead's own timezone", qd?.time_zone === "Europe/Vilnius" && qd?.time_zone_source === "lead");
  assert("happy: sender_bound event written", (await events(f.leadId, "sender_bound")).length === 1);
  const { data: touchRow } = await db.from("touches").select("status, send_account_id, idempotency_key").eq("id", touch).single();
  assert("happy: touch sent from the bound account with its idempotency key", touchRow?.status === "sent" && touchRow.send_account_id === accountA && Boolean(touchRow.idempotency_key));

  const rerun = await runSendJob(deps(INSIDE), job);
  assert("happy: re-running the job → already, zero further adapter calls", rerun.kind === "already" && mock.enroll.length - enrollBefore === 1, rerun.kind);

  console.log("\n--- E6: a step-2 send job → followup_engine_send_disabled (09 §U6c S20) ---");
  const seq = sequences.get(touch)!;
  const callsBefore = providerCalls();
  const resBeforeE6 = await reservationCount(accountA);
  const stepTwo = await runSendJob(deps(INSIDE), jobCtx(seq.stepTwo));
  assert(
    "E6: step 2 refused followup_engine_send_disabled (hold)",
    stepTwo.kind === "refused" && stepTwo.hold && stepTwo.verdicts.map((v) => v.reason).join() === "followup_engine_send_disabled",
    JSON.stringify(stepTwo.kind === "refused" ? stepTwo.verdicts : stepTwo),
  );
  assert("E6: zero provider calls of any kind", providerCalls() === callsBefore, `${callsBefore} → ${providerCalls()}`);
  assert("E6: zero reservations, zero outbox rows", (await reservationCount(accountA)) === resBeforeE6 && (await outboxFor(seq.stepTwo)).length === 0);
  const { data: stepTwoRow } = await db.from("touches").select("status").eq("id", seq.stepTwo).single();
  assert("E6: step 2 stays approved (Instantly owns it), lead stays sent", stepTwoRow?.status === "approved" && (await leadRow(f.leadId)).state === "sent");

  console.log("\n--- DoD: sender pinning (step 1 routed away from the bound mailbox) ---");
  const p = await createLead("pinning");
  const bind = await db.from("leads").update({ send_account_id: accountA }).eq("id", p.leadId);
  if (bind.error) throw new Error(`bind: ${bind.error.message}`);
  const resBefore = await reservationCount(accountB);
  const routed = await createApprovedTouch(p, { sendAccountId: accountB });
  const pinned = await runSendJob(deps(INSIDE), jobCtx(routed));
  assert(
    "pinning: amir@getzyndix while bound to amir@zyndixhq → refused sender_mismatch",
    pinned.kind === "refused" && pinned.verdicts.map((v) => v.reason).join() === "sender_mismatch",
    JSON.stringify(pinned.kind === "refused" ? pinned.verdicts : pinned),
  );
  assert("pinning: no capacity reserved on the other account", (await reservationCount(accountB)) === resBefore);
  assert("pinning: no enroll call", mock.enroll.length - enrollBefore === 1);
  assert("pinning: binding unchanged", (await leadRow(p.leadId)).send_account_id === accountA);
}

/** The body Instantly receives for a step: composed (body + signature), line breaks as <br/>. */
const htmlOf = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br/>");

async function enrollmentRows(leadId: string) {
  const { data, error } = await enrollDb.from("instantly_enrollments").select("*").eq("lead_id", leadId);
  if (error) throw new Error(`enrollments: ${error.message}`);
  return data ?? [];
}

async function u6cEnroll(accountD: string, identifierD: string): Promise<void> {
  console.log("\n--- E1: enroll carries every approved step (09 §U6c S20) ---");
  const f = await createLead("e1");
  const touch = await createApprovedTouch(f, { sendAccountId: accountD });
  const seq = sequences.get(touch)!;
  const before = mock.enroll.length;
  const outcome = await runSendJob(deps(INSIDE), jobCtx(touch));
  const enrolled = mock.enroll[mock.enroll.length - 1]!;
  const vars = enrolled.lead.custom_variables ?? {};
  assert("E1: sent (enroll), leads/add ×1", outcome.kind === "sent" && mock.enroll.length - before === 1, JSON.stringify(outcome));
  assert("E1: into the bound account's campaign", enrolled.campaignId === `${TAG}.camp-D`);
  assert(
    "E1: variables are exactly zx_subject, zx_body, zx_body_2, zx_body_3, zx_touch_id",
    JSON.stringify(Object.keys(vars).sort()) === JSON.stringify(["zx_body", "zx_body_2", "zx_body_3", "zx_subject", "zx_touch_id"]),
    JSON.stringify(Object.keys(vars)),
  );
  const expected = seq.snapshot.steps.map((st) => htmlOf(st.body));
  assert(
    "E1: each zx_body_N = that step's body exactly as the approval hash binds it (body + signature), as HTML",
    vars.zx_body === expected[0] && vars.zx_body_2 === expected[1] && vars.zx_body_3 === expected[2],
    String(vars.zx_body_2).slice(0, 120),
  );
  assert(
    "E1: every body is non-empty and ends with the bound mailbox's signature",
    [vars.zx_body, vars.zx_body_2, vars.zx_body_3].every(
      (v) => typeof v === "string" && v.trim() !== "" && v.endsWith(htmlOf(fixtureSignature(identifierD))),
    ),
  );
  assert(
    "E1: the composed body is composeOutboundBody(approved body, signature)",
    vars.zx_body_2 === htmlOf(composeOutboundBody(STEP_BODIES[2], fixtureSignature(identifierD))),
  );
  assert("E1: zx_subject = step 1 subject, zx_touch_id = step 1 touch", vars.zx_subject === "Your listing pages" && vars.zx_touch_id === touch);
  const rows = await enrollmentRows(f.leadId);
  assert(
    "E1: one instantly_enrollments row, active, bound to the sequence hash, 3 steps, provider lead id",
    rows.length === 1 &&
      rows[0]!.state === "active" &&
      rows[0]!.sequence_hash === seq.hash &&
      rows[0]!.steps_total === 3 &&
      rows[0]!.provider_lead_id === mock.lastLeadId &&
      rows[0]!.campaign_id === `${TAG}.camp-D`,
    JSON.stringify(rows),
  );
  const { data: followRows } = await db.from("touches").select("status").in("id", [seq.stepTwo, seq.stepThree]);
  assert("E1: steps 2–3 stay approved (Instantly sends them)", (followRows ?? []).every((r) => r.status === "approved"));

  const refusedWith = async (
    label: string,
    touchId: string,
    reasons: string[],
    at: Date = INSIDE,
  ): Promise<void> => {
    const enrollBefore = mock.enroll.length;
    const resBefore = await reservationCount(accountD);
    const out = await runSendJob(deps(at), jobCtx(touchId));
    const got = out.kind === "refused" || out.kind === "deferred" ? out.verdicts.map((v) => v.reason) : [];
    assert(
      `${label}: refused ${reasons.join(" + ")}`,
      out.kind === "refused" && JSON.stringify(got) === JSON.stringify(reasons),
      JSON.stringify(out.kind === "refused" ? out.verdicts : out),
    );
    assert(`${label}: 0 enroll calls, 0 reservations, no outbox`, mock.enroll.length === enrollBefore && (await reservationCount(accountD)) === resBefore && (await outboxFor(touchId)).length === 0);
  };

  console.log("\n--- E2: a follow-up killed or missing → sequence_incomplete ---");
  const k = await createLead("e2-killed");
  const killed = await createApprovedTouch(k, { sendAccountId: accountD });
  await db.from("touches").update({ status: "killed" }).eq("id", sequences.get(killed)!.stepTwo);
  await refusedWith("E2 killed step 2", killed, ["sequence_incomplete"]);
  const m = await createLead("e2-missing");
  const missing = await createApprovedTouch(m, { sendAccountId: accountD });
  await db.from("touches").delete().eq("id", sequences.get(missing)!.stepThree);
  await refusedWith("E2 missing step 3", missing, ["stale_approval", "sequence_incomplete"]);

  console.log("\n--- E3: an empty/whitespace step body → sequence_incomplete (blank-email guard) ---");
  const b = await createLead("e3-blank");
  const blank = await createApprovedTouch(b, { sendAccountId: accountD, bodies: { 2: "   \n  " } });
  await refusedWith("E3 whitespace step 2 (approved that way)", blank, ["sequence_incomplete"]);
  const { data: blankEvent } = await db.from("lead_events").select("detail").eq("lead_id", b.leadId).eq("event", "send_refused");
  const blankDetail = JSON.stringify(blankEvent?.[0]?.detail ?? null);
  assert("E3: the refusal names step 2 as blank", blankDetail.includes('"issue":"blank"') && blankDetail.includes('"step":2'), blankDetail);

  console.log("\n--- a step 1 approved alone (pre-U6c snapshot) → sequence_incomplete ---");
  const l = await createLead("legacy-single");
  const legacy = await createApprovedTouch(l, { sendAccountId: accountD, legacySingle: true });
  await refusedWith("legacy single-touch approval", legacy, ["sequence_incomplete"]);

  console.log("\n--- E4: the live campaign's steps differ → campaign_sequence_drift ---");
  const d = await createLead("e4-drift");
  const drift = await createApprovedTouch(d, { sendAccountId: accountD });
  mock.campaignSteps = [{ type: "email", delay: 0, variants: [{ subject: "{{zx_subject}}", body: "{{zx_body}}" }] }];
  await refusedWith("E4 single-step campaign", drift, ["campaign_sequence_drift"]);
  mock.campaignSteps = MATCHING_CAMPAIGN_STEPS().map((st, i) => ({ ...st, delay: [0, 7, 7][i]! }));
  await refusedWith("E4 unshifted delays (0/7/7 on Instantly)", drift, ["campaign_sequence_drift"]);
  mock.campaignSteps = null;
  await refusedWith("E4 campaign unreadable", drift, ["campaign_sequence_drift"]);
  mock.campaignSteps = MATCHING_CAMPAIGN_STEPS();

  console.log("\n--- E5: sent + follow-ups due today + this enroll > daily_limit → provider_daily_limit (deferred) ---");
  // A lead whose step 1 went out from D exactly 7 days ago: its step 2 is due today.
  const due = await createLead("e5-due");
  const dueTouch = await createApprovedTouch(due, { sendAccountId: accountD });
  const sevenDaysAgo = new Date(INSIDE.getTime() - 7 * 86_400_000).toISOString();
  await db.from("touches").update({ status: "sent", sent_at: sevenDaysAgo }).eq("id", dueTouch);
  // E1's step 1 (sent today) has its step 2 due in 7 days: not counted.
  const q = await createLead("e5-full");
  const full = await createApprovedTouch(q, { sendAccountId: accountD });
  mock.dailyLimit = 3;
  mock.sentToday = 2;
  const enrollBefore = mock.enroll.length;
  const deferred = await runSendJob(deps(INSIDE), jobCtx(full));
  const { data: deferredJobs } = await db.from("jobs").select("id, run_after").like("idempotency_key", `send:${full}:%:at:%`);
  fixture.jobIds.push(...(deferredJobs ?? []).map((j) => j.id));
  const verdict = deferred.kind === "deferred" ? deferred.verdicts.find((v) => v.reason === "provider_daily_limit") : null;
  assert(
    "E5: deferred with provider_daily_limit only",
    deferred.kind === "deferred" && deferred.verdicts.map((v) => v.reason).join() === "provider_daily_limit",
    JSON.stringify(deferred),
  );
  assert(
    "E5: the verdict counts sent 2 + 1 follow-up due today against daily_limit 3",
    JSON.stringify(verdict?.detail) === JSON.stringify({ daily_limit: 3, sent_today: 2, followups_due_today: 1 }),
    JSON.stringify(verdict?.detail),
  );
  const runAfter = deferred.kind === "deferred" ? new Date(deferred.runAfter) : null;
  assert(
    "E5: deferred to a window after the next UTC midnight, one job, no enroll",
    runAfter !== null && runAfter >= new Date(`${ledgerDate(new Date(INSIDE.getTime() + 86_400_000))}T00:00:00Z`) && (deferredJobs ?? []).length === 1 && mock.enroll.length === enrollBefore,
    runAfter?.toISOString(),
  );
  mock.sentToday = 1;
  const fits = await runSendJob(deps(INSIDE), jobCtx(full, randomUUID()));
  assert("E5: sent 1 + 1 due + 1 = 3 fits daily_limit 3 → sent", fits.kind === "sent", JSON.stringify(fits));
  const dayD = await ledgerDay(accountD);
  assert("E5: the engine quota is min(ramp, daily_limit) = 3 on the ledger day", dayD?.quota === 3, JSON.stringify(dayD));
  mock.dailyLimit = 50;
  mock.sentToday = 0;
}

async function uncertainOutcomes(accountA: string): Promise<void> {
  console.log("\n--- DoD: uncertain outcome (timeout after dispatch) ---");
  const f = await createLead("uncertain");
  const touch = await createApprovedTouch(f, { sendAccountId: accountA });
  mock.enrollBehaviour = "uncertain";
  const before = mock.enroll.length;
  const job = jobCtx(touch);
  const outcome = await runSendJob(deps(INSIDE), job);
  mock.enrollBehaviour = "created";
  const [ob] = await outboxFor(touch);
  assert("uncertain: outcome uncertain", outcome.kind === "uncertain", JSON.stringify(outcome));
  assert("uncertain: outbox.state = uncertain", ob?.state === "uncertain", ob?.state);
  assert("uncertain: lead still queued", (await leadRow(f.leadId)).state === "queued");
  const reservation = ob?.reservation_id ? await ledger.getReservation(ob.reservation_id) : null;
  assert("uncertain: reservation held as uncertain (capacity not freed)", reservation?.state === "uncertain");
  const rerun = await runSendJob(deps(INSIDE), job);
  const rerunNewJob = await runSendJob(deps(INSIDE), jobCtx(touch));
  assert(
    "uncertain: re-running the job calls the adapter ZERO additional times",
    mock.enroll.length - before === 1 && rerun.kind === "already" && rerunNewJob.kind === "already",
    `${mock.enroll.length - before} calls; ${rerun.kind}/${rerunNewJob.kind}`,
  );
  const { data: reconcileJobs } = await db.from("jobs").select("id").eq("idempotency_key", `reconcile:${ob!.id}`);
  assert("uncertain: exactly one send.reconcile job enqueued", (reconcileJobs ?? []).length === 1);
  fixture.jobIds.push(...(reconcileJobs ?? []).map((j) => j.id));

  mock.findLeadResult = true;
  const reconciled = await runReconcileJob(deps(INSIDE), {
    id: randomUUID(),
    type: "send.reconcile",
    payload: { outbox_id: ob!.id },
    attempt: 1,
    maxAttempts: 5,
    idempotencyKey: null,
  });
  const after = (await outboxFor(touch))[0];
  const res2 = await ledger.getReservation(ob!.reservation_id!);
  assert("reconcile: provider shows the lead → reconciled_sent", reconciled.kind === "reconciled_sent" && after.state === "reconciled_sent");
  assert("reconcile: lead queued → sent, reservation reconciled(sent)", (await leadRow(f.leadId)).state === "sent" && res2?.state === "reconciled" && res2.reconciled_outcome === "sent");
  assert("reconcile: still zero additional enroll calls", mock.enroll.length - before === 1);
  const reconciledRows = await enrollmentRows(f.leadId);
  assert("reconcile: found → one active instantly_enrollments row", reconciledRows.length === 1 && reconciledRows[0]!.state === "active", JSON.stringify(reconciledRows));

  console.log("\n--- reconcile: proven absent → not sent, manual_hold, no resend ---");
  const g = await createLead("absent");
  const touch2 = await createApprovedTouch(g, { sendAccountId: accountA });
  mock.enrollBehaviour = "uncertain";
  await runSendJob(deps(INSIDE), jobCtx(touch2));
  mock.enrollBehaviour = "created";
  const [ob2] = await outboxFor(touch2);
  const { data: rj } = await db.from("jobs").select("id").eq("idempotency_key", `reconcile:${ob2.id}`);
  fixture.jobIds.push(...(rj ?? []).map((j) => j.id));
  mock.findLeadResult = false;
  const alertsBefore = mock.alerts.length;
  const enrollBefore = mock.enroll.length;
  const absent = await runReconcileJob(deps(INSIDE), {
    id: randomUUID(),
    type: "send.reconcile",
    payload: { outbox_id: ob2.id },
    attempt: 1,
    maxAttempts: 5,
    idempotencyKey: null,
  });
  mock.findLeadResult = true;
  const res3 = await ledger.getReservation(ob2.reservation_id!);
  assert("reconcile: absent → reconciled_not_sent", absent.kind === "reconciled_not_sent");
  assert("reconcile: lead → manual_hold, operator alerted", (await leadRow(g.leadId)).state === "manual_hold" && mock.alerts.length === alertsBefore + 1);
  assert("reconcile: reservation reconciled(not_sent), nothing resent", res3?.reconciled_outcome === "not_sent" && mock.enroll.length === enrollBefore);

  console.log("\n--- skipped already_enrolled → uncertain, never treated as sent ---");
  const h = await createLead("already");
  const touch3 = await createApprovedTouch(h, { sendAccountId: accountA });
  mock.enrollBehaviour = "already";
  const already = await runSendJob(deps(INSIDE), jobCtx(touch3));
  mock.enrollBehaviour = "created";
  const [ob3] = await outboxFor(touch3);
  const { data: rj3 } = await db.from("jobs").select("id").eq("idempotency_key", `reconcile:${ob3.id}`);
  fixture.jobIds.push(...(rj3 ?? []).map((j) => j.id));
  assert("already_enrolled: outbox uncertain, reconcile queued", already.kind === "uncertain" && ob3.state === "uncertain" && (rj3 ?? []).length === 1);
}

async function workerCrash(accountA: string): Promise<void> {
  console.log("\n--- DoD: worker crash, lease expires mid-flight ---");
  const f = await createLead("crash");
  const touch = await createApprovedTouch(f, { sendAccountId: accountA });
  const jobType = `${TAG}.send`;
  const { job } = await queue.enqueue({ type: jobType, payload: { touch_id: touch } });
  fixture.jobIds.push(job.id);
  const [claimed] = await queue.claim({ owner: `${TAG}.w1`, types: [jobType], leaseSeconds: 1 });
  const before = mock.enroll.length;
  let crashed = false;
  try {
    await runSendJob(
      deps(INSIDE, {
        afterDispatch: async () => {
          throw new Error("simulated worker death after the provider call");
        },
      }),
      { id: claimed.id, type: SEND_JOB_TYPE, payload: { touch_id: touch }, attempt: claimed.attempts, maxAttempts: claimed.max_attempts, idempotencyKey: claimed.idempotency_key },
    );
  } catch {
    crashed = true; // the worker "dies": no complete(), no fail() — the lease just runs out
  }
  const mid = (await outboxFor(touch))[0];
  assert("crash: provider was called once, outbox left dispatching", crashed && mock.enroll.length - before === 1 && mid?.state === "dispatching");
  await new Promise((r) => setTimeout(r, 2200));
  const [reclaimed] = await queue.claim({ owner: `${TAG}.w2`, types: [jobType], leaseSeconds: 30 });
  assert("crash: the expired lease is re-claimed", reclaimed?.id === claimed.id && reclaimed.attempts === 2, `${reclaimed?.attempts}`);
  const outcome = await runSendJob(deps(INSIDE), {
    id: reclaimed.id,
    type: SEND_JOB_TYPE,
    payload: { touch_id: touch },
    attempt: reclaimed.attempts,
    maxAttempts: reclaimed.max_attempts,
    idempotencyKey: reclaimed.idempotency_key,
  });
  const after = (await outboxFor(touch))[0];
  assert("crash: re-claim produces ZERO additional adapter calls", mock.enroll.length - before === 1, `${mock.enroll.length - before}`);
  assert("crash: the dispatching row becomes uncertain → reconcile", outcome.kind === "uncertain" && after.state === "uncertain");
  assert("crash: lead stays queued", (await leadRow(f.leadId)).state === "queued");
  const { data: rj } = await db.from("jobs").select("id").eq("idempotency_key", `reconcile:${after.id}`);
  fixture.jobIds.push(...(rj ?? []).map((j) => j.id));
  await queue.complete(reclaimed, `${TAG}.w2`);
}

async function suppressionBetween(accountC: string): Promise<void> {
  console.log("\n--- DoD: suppression inserted between approval and send ---");
  const f = await createLead("suppressed");
  const touch = await createApprovedTouch(f, { sendAccountId: accountC });
  fixture.suppressionEmails.push(f.email);
  const before = mock.enroll.length;
  let reservedDuring = -1;
  const outcome = await runSendJob(
    deps(INSIDE, {
      afterReserve: async () => {
        reservedDuring = (await ledgerDay(accountC))?.reserved ?? -1;
        const { error } = await db.from("suppression_list").insert({ email: f.email.toUpperCase(), reason: "test_u5_opt_out" });
        if (error) throw new Error(`suppression insert: ${error.message}`);
      },
    }),
    jobCtx(touch),
  );
  const day = await ledgerDay(accountC);
  assert(
    "suppression: refused with suppressed_email (case-insensitive match)",
    outcome.kind === "refused" && outcome.verdicts.map((v) => v.reason).join() === "suppressed_email",
    JSON.stringify(outcome.kind === "refused" ? outcome.verdicts : outcome),
  );
  assert("suppression: capacity was reserved, then reserved returns to 0", reservedDuring === 1 && day?.reserved === 0, `${reservedDuring} → ${day?.reserved}`);
  assert("suppression: no provider call, no outbox row, lead still approved", mock.enroll.length === before && (await outboxFor(touch)).length === 0 && (await leadRow(f.leadId)).state === "approved");
  const refused = await events(f.leadId, "send_refused");
  assert("suppression: send_refused event records the final-preflight verdicts", refused.length === 1 && (refused[0].detail as Record<string, unknown>).phase === "final_preflight");
}

function providerCalls(): number {
  return mock.enroll.length + mock.listEmails.length + mock.findLead.length + mock.health.length;
}

async function pausedSender(accountC: string): Promise<void> {
  console.log("\n--- paused sender → refused with ZERO provider calls of any kind (Session 13, U6 DoD) ---");
  const f = await createLead("paused");
  const touch = await createApprovedTouch(f, { sendAccountId: accountC });
  const { error } = await db.from("send_accounts").update({ health: "paused", paused_reason: "test_u5 paused" }).eq("id", accountC);
  if (error) throw new Error(`pause: ${error.message}`);
  const before = providerCalls();
  const outcome = await runSendJob(deps(INSIDE), jobCtx(touch));
  const after = providerCalls();
  const restore = await db.from("send_accounts").update({ health: "ok", paused_reason: null }).eq("id", accountC);
  if (restore.error) throw new Error(`unpause: ${restore.error.message}`);
  assert(
    "paused: refused sender_unhealthy, lead still approved",
    outcome.kind === "refused" && outcome.verdicts.some((v) => v.reason === "sender_unhealthy") && (await leadRow(f.leadId)).state === "approved",
    JSON.stringify(outcome.kind === "refused" ? outcome.verdicts : outcome),
  );
  assert("paused: zero provider calls (no enroll, listEmails, findLead, getAccount, warmup, campaign or daily read)", after === before, `${before} → ${after}`);
}

async function signatureEditedAfterApproval(accountC: string): Promise<void> {
  console.log("\n--- signature edited after approval → stale_approval (Session 12) ---");
  const f = await createLead("sig-edit");
  const touch = await createApprovedTouch(f, { sendAccountId: accountC });
  const { error } = await db.from("send_accounts").update({ signature_text: "Someone Else\nZyndix" }).eq("id", accountC);
  if (error) throw new Error(`signature edit: ${error.message}`);
  const before = mock.enroll.length;
  const outcome = await runSendJob(deps(INSIDE), jobCtx(touch));
  const restore = await db.from("send_accounts").update({ signature_text: fixtureSignature(`u5-${STAMP}-ingrida@zyndixhq.com`) }).eq("id", accountC);
  if (restore.error) throw new Error(`signature restore: ${restore.error.message}`);
  assert(
    "signature: refused stale_approval, no provider call, lead still approved",
    outcome.kind === "refused" &&
      outcome.verdicts.map((v) => v.reason).join() === "stale_approval" &&
      mock.enroll.length === before &&
      (await leadRow(f.leadId)).state === "approved",
    JSON.stringify(outcome.kind === "refused" ? outcome.verdicts : outcome),
  );
}

async function timezoneCases(accountC: string): Promise<void> {
  console.log("\n--- timezone_unknown is a HOLD, never a deferral (operator rule) ---");
  const f = await createLead("tz-unknown", { country: "US", leadTimezone: null });
  const touch = await createApprovedTouch(f, { sendAccountId: accountC });
  const alertsBefore = mock.alerts.length;
  const reservedBefore = await reservationCount(accountC);
  const jobsBefore = await jobsForTouch(touch);
  const outcome = await runSendJob(deps(INSIDE), jobCtx(touch));
  assert(
    "tz: refused timezone_unknown, not outside_window",
    outcome.kind === "refused" && outcome.verdicts.map((v) => v.reason).join() === "timezone_unknown",
    JSON.stringify(outcome.kind === "refused" ? outcome.verdicts : outcome),
  );
  assert("tz: send_refused event written", (await events(f.leadId, "send_refused")).length === 1);
  assert("tz: nothing reserved (reserved stays 0)", (await reservationCount(accountC)) === reservedBefore && ((await ledgerDay(accountC))?.reserved ?? 0) === 0);
  assert("tz: NO deferred job created", (await jobsForTouch(touch)) === jobsBefore, `${jobsBefore} → ${await jobsForTouch(touch)}`);
  assert("tz: operator alerted exactly once", mock.alerts.length === alertsBefore + 1 && mock.alerts[mock.alerts.length - 1].includes("timezone_unknown"));
  assert("tz: lead stays approved (held, not moved)", (await leadRow(f.leadId)).state === "approved");

  console.log("\n--- country fallback: single-zone HQ country resolves the window ---");
  const g = await createLead("tz-fallback", { country: "LT", leadTimezone: null });
  const touch2 = await createApprovedTouch(g, { sendAccountId: accountC });
  const sent = await runSendJob(deps(INSIDE), jobCtx(touch2));
  const detail = (await events(g.leadId, "send_queued"))[0]?.detail as Record<string, unknown> | undefined;
  assert("fallback: sent, with time_zone Europe/Vilnius from country_fallback", sent.kind === "sent" && detail?.time_zone === "Europe/Vilnius" && detail?.time_zone_source === "country_fallback", JSON.stringify(detail));

  console.log("\n--- outside_window defers to the next window (timezone known) ---");
  const h = await createLead("weekend");
  const touch3 = await createApprovedTouch(h, { sendAccountId: accountC });
  const before = mock.enroll.length;
  const deferred = await runSendJob(deps(WEEKEND), jobCtx(touch3));
  const { data: deferredJobs } = await db.from("jobs").select("id, run_after, type").like("idempotency_key", `send:${touch3}:%`);
  fixture.jobIds.push(...(deferredJobs ?? []).map((j) => j.id));
  const runAfter = deferredJobs?.[0]?.run_after ? new Date(deferredJobs[0].run_after) : null;
  assert("window: outside_window → deferred, one send.email job queued", deferred.kind === "deferred" && (deferredJobs ?? []).length === 1 && deferredJobs![0].type === SEND_JOB_TYPE);
  assert(
    // Sat 12:00 → Tue 08:30 is 68.5h away, beyond the 48h priority lookahead
    // (U3 rule), so the next window is Monday's secondary 13:30–16:00 Vilnius.
    "window: the deferred run is inside Mon 2026-10-05 13:30–16:00 Vilnius (secondary; priority is beyond the 48h lookahead)",
    runAfter !== null && runAfter >= new Date("2026-10-05T10:30:00Z") && runAfter < new Date("2026-10-05T13:00:00Z"),
    runAfter?.toISOString(),
  );
  assert("window: no provider call, no reservation, lead still approved", mock.enroll.length === before && (await leadRow(h.leadId)).state === "approved");
}

// ---------------------------------------------------------------------------
// Row counts, cleanup
// ---------------------------------------------------------------------------

const TABLES = [
  "leads",
  "touches",
  "lead_events",
  "jobs",
  "companies",
  "send_accounts",
  "capacity_ledger",
  "capacity_reservations",
  "outbox",
  "suppression_list",
  "instantly_enrollments",
] as const;

async function countRows(table: (typeof TABLES)[number] | "instantly_enrollments"): Promise<number> {
  const { count, error } = await enrollDb.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

async function migrationApplied(): Promise<boolean> {
  const { error } = await db.from("outbox").select("id").limit(1);
  if (!error) {
    const { error: colError } = await db.from("touches").select("approval_hash").limit(1);
    const { error: sigError } = await db.from("send_accounts").select("signature_text").limit(1);
    return !colError && !sigError;
  }
  if (error.code === "PGRST205" || /schema cache/i.test(error.message)) return false;
  throw new Error(`outbox probe: ${error.message}`);
}

async function cleanup(): Promise<void> {
  const del = async (label: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await run();
    if (error) console.error(`cleanup ${label}: ${error.message}`);
  };
  if (fixture.touchIds.length) {
    await del("jobs(send)", () => db.from("jobs").delete().or(fixture.touchIds.map((t) => `idempotency_key.like.send:${t}:*`).join(",")));
  }
  const { data: outboxRows } = fixture.leadIds.length
    ? await db.from("outbox").select("id").in("lead_id", fixture.leadIds)
    : { data: [] };
  const outboxIds = (outboxRows ?? []).map((o) => o.id);
  if (outboxIds.length) {
    await del("jobs(reconcile)", () => db.from("jobs").delete().in("idempotency_key", outboxIds.map((id) => `reconcile:${id}`)));
  }
  if (fixture.jobIds.length) await del("jobs(ids)", () => db.from("jobs").delete().in("id", fixture.jobIds));
  await del("jobs(type)", () => db.from("jobs").delete().like("type", `${TAG}.%`));
  if (fixture.leadIds.length) {
    await del("outbox", () => db.from("outbox").delete().in("lead_id", fixture.leadIds));
    await del("instantly_enrollments", () => enrollDb.from("instantly_enrollments").delete().in("lead_id", fixture.leadIds));
    await del("touches", () => db.from("touches").delete().in("lead_id", fixture.leadIds));
    await del("lead_events", () => db.from("lead_events").delete().in("lead_id", fixture.leadIds));
    await del("exceptions", () => exceptionsDb.from("exceptions").delete().in("lead_id", fixture.leadIds));
    await del("leads", () => db.from("leads").delete().in("id", fixture.leadIds));
  }
  for (const email of fixture.suppressionEmails) {
    await del("suppression", () => db.from("suppression_list").delete().ilike("email", email));
  }
  if (fixture.companyIds.length) await del("companies", () => db.from("companies").delete().in("id", fixture.companyIds));
  if (fixture.accountIds.length) await del("send_accounts", () => db.from("send_accounts").delete().in("id", fixture.accountIds));
}

async function main(): Promise<void> {
  console.log(`\n=== test-u5-send (tag=${TAG}) ===`);
  if (!(await migrationApplied())) {
    skip("all U5 DB checks", "outbox / touches.approval_hash / send_accounts.signature_text not found — apply 0008, 0008b and 0009_send_prereqs.sql");
  } else {
    const before: Record<string, number> = {};
    for (const t of TABLES) before[t] = await countRows(t);
    console.log(`BEFORE  ${TABLES.map((t) => `${t}=${before[t]}`).join(" ")}`);
    try {
      const accountA = await createAccount(SENDER_A, "camp-A");
      const accountB = await createAccount(SENDER_B, "camp-B");
      const accountC = await createAccount(`u5-${STAMP}-ingrida@zyndixhq.com`, "camp-C");
      const identifierD = `u5-${STAMP}-ingrida@getzyndix.com`;
      const accountD = await createAccount(identifierD, "camp-D");
      await happyPathAndPinning(accountA, accountB);
      await u6cEnroll(accountD, identifierD);
      await uncertainOutcomes(accountA);
      await workerCrash(accountA);
      await suppressionBetween(accountC);
      await signatureEditedAfterApproval(accountC);
      await pausedSender(accountC);
      await timezoneCases(accountC);
    } catch (error) {
      assert("no unexpected exception", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    } finally {
      await cleanup();
      console.log("\nCleanup: fixture rows removed.");
    }
    const after: Record<string, number> = {};
    for (const t of TABLES) after[t] = await countRows(t);
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
  console.error("test-u5-send crashed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});

