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
  type ReplyToEmailInput,
} from "../src/lib/integrations/instantly";
import type { InstantlyAccount, InstantlyEmail } from "../src/lib/integrations/instantly-types";
import { createJobQueue } from "../src/lib/jobs/queue";
import type { JobContext } from "../src/lib/jobs/registry";
import { createCapacityLedger } from "../src/lib/scheduler/ledger";
import { ledgerDate } from "../src/lib/scheduler/windows";
import { approvalHash, buildApprovalSnapshot } from "../src/lib/sending/approval";
import { threadedSubject } from "../src/lib/sending/preflight";
import { capacity_defaults, send_policy, send_windows } from "../src/lib/settings/seed-content";
import {
  runReconcileJob,
  runSendJob,
  SEND_JOB_TYPE,
  type SendDeps,
} from "../src/lib/stages/send/core";
import { createStateStore } from "../src/lib/state/core";
import type { Database } from "../src/types/database";
import type { DatabaseWithCapacity, DatabaseWithJobs, DatabaseWithSending } from "../src/types/database-extensions";
import type { LeadState } from "../src/types/enums";

// U5 DoD against Supabase (09 §U5). Every row it touches is a synthetic
// fixture tagged with TAG; the Instantly adapter is a counting mock, so no
// provider is called and nothing is sent. Lead states move only through
// lib/state (transition), never by writing leads.state.

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const raw = createServiceClient(url, key);
const db = raw as unknown as SupabaseClient<DatabaseWithSending>;
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
  reply: ReplyToEmailInput[];
  listEmails: ListEmailsParams[];
  findLead: Array<{ campaignId: string; email: string }>;
  /** getAccount + getWarmupAnalytics reads (Session 13: a paused sender makes none). */
  health: string[];
  enrollBehaviour: "created" | "uncertain" | "already";
  anchorEmail: InstantlyEmail | null;
  findLeadResult: boolean;
  alerts: string[];
};

const mock: Mock = {
  enroll: [],
  reply: [],
  listEmails: [],
  findLead: [],
  health: [],
  enrollBehaviour: "created",
  anchorEmail: null,
  findLeadResult: true,
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
  } as InstantlyAccount;
}

const settings: Record<string, unknown> = {
  send_policy,
  send_windows,
  capacity_defaults,
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
        return { outcome: "created", leadId: randomUUID(), raw: {} as never };
      },
      async replyToEmail(input) {
        mock.reply.push(input);
        return {
          id: randomUUID(),
          timestamp_created: now.toISOString(),
          message_id: `<${randomUUID()}@example.invalid>`,
          subject: input.subject,
          eaccount: input.eaccount,
          to_address_email_list: "x@example.invalid",
          thread_id: mock.anchorEmail?.thread_id ?? null,
        } as InstantlyEmail;
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
        return { items: mock.anchorEmail ? [mock.anchorEmail] : [] };
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

/** A touch approved with a real approval binding (what the Telegram handler writes). */
async function createApprovedTouch(
  f: LeadFixture,
  opts: { step?: number; subject?: string; sendAccountId?: string | null; transitionLead?: boolean } = {},
): Promise<string> {
  const step = opts.step ?? 1;
  const { data: touch, error } = await db
    .from("touches")
    .insert({
      lead_id: f.leadId,
      step_no: step,
      channel: "email",
      direction: "outbound",
      status: "pending_approval",
      subject: opts.subject ?? "Your listing pages",
      draft_body: "Hi Test,\n\nA specific observation.\n\nWant the three?",
      body: null,
      prompt_version: 7,
      send_account_id: opts.sendAccountId ?? null,
    })
    .select("id, step_no, channel, subject, draft_body, prompt_version")
    .single();
  if (error || !touch) throw new Error(`fixture touch: ${error?.message}`);
  fixture.touchIds.push(touch.id);

  // The sender is fixed at approval (Session 12): the given account, else the
  // lead's binding — what the Telegram handler does.
  const body = touch.draft_body!;
  const senderId = opts.sendAccountId ?? (await leadRow(f.leadId)).send_account_id;
  const { data: sender } = senderId
    ? await db.from("send_accounts").select("id, signature_text").eq("id", senderId).single()
    : { data: null };
  const snapshot = buildApprovalSnapshot({ ...touch, body }, { id: f.leadId, email: f.email }, sender);
  const { error: approveError } = await db
    .from("touches")
    .update({
      body,
      send_account_id: senderId,
      status: "approved",
      approval_hash: approvalHash(snapshot),
      approval_snapshot: snapshot as never,
      approved_at: new Date().toISOString(),
      approved_by: "test:u5",
    })
    .eq("id", touch.id);
  if (approveError) throw new Error(`fixture approve: ${approveError.message}`);
  if (opts.transitionLead !== false) {
    await state.transition(f.leadId, "pending_approval", "approved", "approved", { touch_id: touch.id, source: "test" });
  }
  return touch.id;
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

  console.log("\n--- threaded follow-up (emails/reply into step 1's thread) ---");
  mock.anchorEmail = null;
  const noAnchor = await createApprovedTouch(f, { step: 2, subject: threadedSubject("Your listing pages"), transitionLead: false });
  const missing = await runSendJob(deps(INSIDE), jobCtx(noAnchor));
  assert(
    "thread: step-1 email not found → thread_anchor_missing (hold)",
    missing.kind === "refused" && missing.verdicts.map((v) => v.reason).join() === "thread_anchor_missing",
    JSON.stringify(missing.kind === "refused" ? missing.verdicts : missing),
  );

  const anchorId = randomUUID();
  mock.anchorEmail = {
    id: anchorId,
    timestamp_created: INSIDE.toISOString(),
    message_id: "<step1@example.invalid>",
    subject: "Your listing pages",
    eaccount: SENDER_A,
    to_address_email_list: f.email,
    thread_id: `${TAG}.thread`,
    ue_type: 1,
  } as InstantlyEmail;
  console.log("\n--- DoD: sender pinning (follow-up routed to the other domain) ---");
  const resBefore = await reservationCount(accountB);
  const followUp = await createApprovedTouch(f, {
    step: 2,
    subject: threadedSubject("Your listing pages"),
    sendAccountId: accountB,
    transitionLead: false,
  });
  const replyBefore = mock.reply.length;
  const pinned = await runSendJob(deps(INSIDE), jobCtx(followUp));
  assert(
    "pinning: amir@getzyndix after amir@zyndixhq → refused sender_mismatch",
    pinned.kind === "refused" && pinned.verdicts.map((v) => v.reason).join() === "sender_mismatch",
    JSON.stringify(pinned.kind === "refused" ? pinned.verdicts : pinned),
  );
  assert("pinning: no capacity reserved on the other account", (await reservationCount(accountB)) === resBefore);
  assert("pinning: no provider call", mock.reply.length === replyBefore && mock.enroll.length - enrollBefore === 1);
  assert("pinning: binding unchanged", (await leadRow(f.leadId)).send_account_id === accountA);

  console.log("\n--- threaded follow-up sent ---");
  const threaded = await createApprovedTouch(f, { step: 2, subject: threadedSubject("Your listing pages"), transitionLead: false });
  const sent = await runSendJob(deps(INSIDE), jobCtx(threaded));
  const lastReply = mock.reply[mock.reply.length - 1];
  assert("thread: follow-up sent via reply", sent.kind === "sent" && sent.operation === "reply", JSON.stringify(sent));
  assert(
    "thread: reply goes from the BOUND mailbox to step 1's email id",
    lastReply?.eaccount === SENDER_A && lastReply.replyToUuid === anchorId && lastReply.subject === "Re: Your listing pages",
  );
  const [stepOneOutbox] = await outboxFor(touch);
  assert(
    "thread: follow-up text ends with the same mailbox's signature (Session 12)",
    lastReply?.body.text === `Hi Test,\n\nA specific observation.\n\nWant the three?\n\n${fixtureSignature(SENDER_A)}`,
    lastReply?.body.text?.slice(-60),
  );
  assert("thread: anchor persisted on the step-1 outbox row", stepOneOutbox?.provider_email_id === anchorId && stepOneOutbox.provider_thread_id === `${TAG}.thread`);
  assert("thread: lead stays sent", (await leadRow(f.leadId)).state === "sent");
  assert("thread: ledger accepted = 2 on the bound account", (await ledgerDay(accountA))?.accepted === 2);
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
  return mock.enroll.length + mock.reply.length + mock.listEmails.length + mock.findLead.length + mock.health.length;
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
  assert("paused: zero provider calls (no enroll, reply, listEmails, findLead, getAccount or warmup read)", after === before, `${before} → ${after}`);
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
] as const;

async function countRows(table: (typeof TABLES)[number]): Promise<number> {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
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
    await del("touches", () => db.from("touches").delete().in("lead_id", fixture.leadIds));
    await del("lead_events", () => db.from("lead_events").delete().in("lead_id", fixture.leadIds));
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
      await happyPathAndPinning(accountA, accountB);
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

