import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createServiceClient } from "../src/lib/db/service-client";
import type { EnrollLeadInput } from "../src/lib/integrations/instantly";
import type { InstantlyAccount, InstantlyCampaignDetail, InstantlyEmail } from "../src/lib/integrations/instantly-types";
import { createJobQueue, type JobQueue } from "../src/lib/jobs/queue";
import { defineJob, type RegisteredJob } from "../src/lib/jobs/registry";
import type { StageName } from "../src/lib/jobs/types";
import { runDaily } from "../src/lib/orchestrator/daily";
import { buildJobRegistry } from "../src/lib/orchestrator/registry";
import { runOrchestrate, runSafety, type CronDeps } from "../src/lib/orchestrator/run";
import { runSendEnqueueStage } from "../src/lib/orchestrator/send-enqueue";
import { createLeaseProbe, STAGE_ORDER, stageJobDefinitions, type StageJobDeps } from "../src/lib/orchestrator/stages";
import { readOperationsPause } from "../src/lib/orchestrator/pause";
import { createCapacityLedger } from "../src/lib/scheduler/ledger";
import { ledgerDate } from "../src/lib/scheduler/windows";
import { engineTimings, instantlySequencePayload } from "../src/lib/sending/campaign-sequence";
import { buildSequenceApprovalSnapshot, sequenceApprovalHash, type EmailSequence } from "../src/lib/sending/sequence-approval";
import { capacity_defaults, send_policy, send_windows } from "../src/lib/settings/seed-content";
import { enqueueSend, runSendJob, type SendDeps, type SendOutcome } from "../src/lib/stages/send/core";
import { sendJobPayloadSchema } from "../src/lib/stages/send/jobs";
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

// U9 DoD against Supabase (09 §U9). The real jobs table, claim_jobs() and
// idempotency index run the orchestrator; every job type in this suite is
// TAG-prefixed (the CronDeps test seams), so the worker can never claim a
// real job. Stage runners and Instantly are counting mocks; a fetch guard
// fails on any non-Supabase call. Every row is a synthetic fixture tagged
// with TAG and removed afterwards; lead states move only through lib/state;
// BEFORE = AFTER on every counted table. The real operations_pause /
// orchestrator_budgets settings rows are never read or written: settings are
// an in-memory mock.

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const raw = createServiceClient(url, key);
const db = raw as unknown as SupabaseClient<DatabaseWithSending>;
const hookDb = raw as unknown as SupabaseClient<DatabaseWithWebhooks>;
const enrollDb = raw as unknown as SupabaseClient<DatabaseWithEnrollments>;
const jobsDb = raw as unknown as SupabaseClient<DatabaseWithJobs>;
const realQueue = createJobQueue(jobsDb);
const ledger = createCapacityLedger(raw as unknown as SupabaseClient<DatabaseWithCapacity>);
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
const TAG = `test.u9.${STAMP}`;
// Tue 2026-09-29 09:00 Europe/Vilnius — inside the priority window (send stage clock).
const INSIDE = new Date("2026-09-29T06:00:00.000Z");
const NOW = new Date();

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

const fixture = {
  accountIds: [] as string[],
  companyIds: [] as string[],
  leadIds: [] as string[],
  touchIds: [] as string[],
};

// ---------------------------------------------------------------------------
// Job types (TAG-prefixed test seams) and a queue that maps the send stage's
// hard-coded send.email / send.reconcile onto them.
// ---------------------------------------------------------------------------

const T = (name: string) => `${TAG}.${name}`;
const T_SEND = T("send.email");
const T_SEND_RECONCILE = T("send.reconcile");
const T_RECIPIENT = T("send.recipient_check");
const T_SWEEPS = [T("reconcile.stale_stop"), T("reconcile.reply_poll"), T("reconcile.instantly_leads")];
const T_CLASSIFY = T("classify.reply");
const T_RESEARCH = T("research.company");
const stageTypes = (prefix: string) =>
  Object.fromEntries(STAGE_ORDER.map((s) => [s, `${TAG}.${prefix}.stage.${s}`])) as Record<StageName, string>;

const mappedQueue: JobQueue = {
  ...realQueue,
  enqueue: (input) =>
    realQueue.enqueue({
      ...input,
      type: input.type === "send.email" ? T_SEND : input.type === "send.reconcile" ? T_SEND_RECONCILE : input.type,
    }),
};

// ---------------------------------------------------------------------------
// Mocks: settings, Instantly (send stage), stage runners with counting adapters
// ---------------------------------------------------------------------------

const EMAIL_SEQUENCE: EmailSequence = {
  steps: [
    { step_no: 1, delay: 0, delay_unit: "days", source: "writer" },
    { step_no: 2, delay: 7, delay_unit: "days", source: "writer" },
    { step_no: 3, delay: 7, delay_unit: "days", source: "template" },
  ],
};
const STEP_BODIES = {
  1: "Hi Test,\n\nA specific observation.\n\nWant the three?",
  2: "A different observation, from another evidence item.",
  3: "Hi Test,\n\nI haven't heard back, so I'll leave it here.",
} as const;

const settings: Record<string, unknown> = {
  send_policy,
  send_windows,
  capacity_defaults,
  email_sequence: EMAIL_SEQUENCE,
  operations_pause: { global: false, reason: null, paused_campaign_ids: [] as string[] },
  orchestrator_budgets: {
    run_budget_ms: 240_000,
    safety_budget_ms: 240_000,
    stages: { source: 2, enrich: 3, qualify: 0, verify: 4, draft: 1, send_enqueue: 5, classify: 10 },
  },
};
const getActiveSetting = async (k: string) => {
  if (!(k in settings)) throw new Error(`No active setting found for key "${k}"`);
  return { version: 1, value: settings[k] };
};
const setPause = (global: boolean, campaigns: string[] = []) => {
  settings.operations_pause = { global, reason: global ? "u9 test" : null, paused_campaign_ids: campaigns };
};

const adapters = { apollo: 0, apify: 0, anthropic: 0, millionverifier: 0, instantly: 0, telegram: 0 };
const providerCalls = () => Object.values(adapters).reduce((s, n) => s + n, 0);
const mock = { enroll: [] as EnrollLeadInput[], health: [] as string[], alerts: [] as string[], pauseCampaign: [] as string[] };

function sendDeps(): SendDeps {
  return {
    db,
    instantly: {
      async enrollLead(input) {
        adapters.instantly += 1;
        mock.enroll.push(input);
        return { outcome: "created", leadId: randomUUID(), raw: {} as never };
      },
      async getCampaign(id) {
        adapters.instantly += 1;
        mock.health.push(`getCampaign:${id}`);
        return {
          id,
          name: "mock",
          status: 1,
          timestamp_created: INSIDE.toISOString(),
          sequences: [{ steps: instantlySequencePayload(engineTimings(EMAIL_SEQUENCE))[0]!.steps }],
        } as InstantlyCampaignDetail;
      },
      async getAccountDailyAnalytics(params) {
        adapters.instantly += 1;
        return params.emails.map((email) => ({ date: params.startDate, email_account: email, sent: 0 }));
      },
      async getAccount(email) {
        adapters.instantly += 1;
        mock.health.push(`getAccount:${email}`);
        return {
          email,
          timestamp_created: "2026-09-24T09:00:00.000Z",
          status: 1,
          warmup_status: 1,
          provider_code: 2,
          setup_pending: false,
          stat_warmup_score: 100,
          daily_limit: 50,
        } as InstantlyAccount;
      },
      async getWarmupAnalytics(emails) {
        adapters.instantly += 1;
        return { aggregate_data: Object.fromEntries(emails.map((e) => [e, { health_score: 100 }])) };
      },
      async findLeadInCampaign() {
        adapters.instantly += 1;
        return null;
      },
      async listEmails() {
        adapters.instantly += 1;
        return { items: [] as InstantlyEmail[], truncated: false };
      },
    },
    ledger,
    queue: mappedQueue,
    transition: state.transition,
    getActiveSetting,
    alert: async (text) => {
      mock.alerts.push(text);
    },
    now: () => INSIDE,
    rng: () => 0.5,
  };
}

const sendOutcomes = new Map<string, SendOutcome>();
const runnerCalls: Array<{ stage: StageName; limit: number }> = [];
const handled: string[] = [];
let registryBuilds = 0;
let fixtureLeadIds: string[] = [];

/** A registry of TAG-typed jobs: mock stages (real send_enqueue), the real send job, counting safety jobs. */
function testRegistry(prefix: string, opts: { runnerDelayMs?: number } = {}) {
  const types = stageTypes(prefix);
  const mockRunner = (stage: StageName, adapter: keyof typeof adapters) => async ({ limit }: { limit: number }) => {
    runnerCalls.push({ stage, limit });
    adapters[adapter] += 1;
    if (opts.runnerDelayMs) await new Promise((r) => setTimeout(r, opts.runnerDelayMs));
    return { mocked: true };
  };
  const readPause = () => readOperationsPause(getActiveSetting);
  const stageDeps: StageJobDeps = {
    runners: {
      source: mockRunner("source", "apollo"),
      enrich: mockRunner("enrich", "apify"),
      qualify: mockRunner("qualify", "anthropic"),
      verify: mockRunner("verify", "millionverifier"),
      draft: mockRunner("draft", "anthropic"),
      send_enqueue: async ({ limit }) => {
        runnerCalls.push({ stage: "send_enqueue", limit });
        return runSendEnqueueStage({ db, queue: mappedQueue, readPause }, { limit, leadIds: fixtureLeadIds });
      },
    },
    countLeased: createLeaseProbe(jobsDb),
    readPause,
    types,
  };
  const counting = (type: string, adapter: keyof typeof adapters): RegisteredJob =>
    defineJob({
      type,
      payloadSchema: z.unknown(),
      timeoutMs: 30_000,
      handler: async () => {
        handled.push(type);
        adapters[adapter] += 1;
      },
    });
  return {
    types,
    build: () => {
      registryBuilds += 1;
      return buildJobRegistry({
        send: [
          defineJob({
            type: T_SEND,
            payloadSchema: sendJobPayloadSchema,
            timeoutMs: 45_000,
            handler: async (job) => {
              sendOutcomes.set(job.payload.touch_id, await runSendJob(sendDeps(), job));
            },
          }),
          counting(T_SEND_RECONCILE, "instantly"),
          counting(T_RECIPIENT, "instantly"),
        ],
        reconcile: T_SWEEPS.map((t) => counting(t, "instantly")),
        classify: [counting(T_CLASSIFY, "anthropic")],
        research: [counting(T_RESEARCH, "apify")],
        stages: stageJobDefinitions(stageDeps),
      });
    },
  };
}

function cronDeps(reg: ReturnType<typeof testRegistry>): CronDeps {
  return {
    queue: realQueue,
    registry: reg.build,
    getActiveSetting,
    stageTypes: reg.types,
    safetyTypes: [T_RECIPIENT, T_SEND_RECONCILE, ...T_SWEEPS],
    sweepTypes: T_SWEEPS,
    classifyType: T_CLASSIFY,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Account = { id: string; identifier: string; campaign: string };

async function createAccount(name: string, opts: { health?: string; rampStartedOn?: string | null; rampStage?: string } = {}): Promise<Account> {
  const identifier = `u9-${STAMP}-${name}@zyndixhq.com`;
  const campaign = `${TAG}.camp-${name}`;
  const { data, error } = await db
    .from("send_accounts")
    .insert({
      kind: "email",
      identifier,
      domain: "zyndixhq.com",
      provider: "test",
      health: opts.health ?? "ok",
      ramp_stage: opts.rampStage ?? "warmup",
      ramp_started_on: opts.rampStartedOn === undefined ? "2026-09-01" : opts.rampStartedOn,
      instantly_campaign_id: campaign,
      signature_text: `Test ${name}\nZyndix, Vilnius\nzyndix.com`,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fixture account: ${error?.message}`);
  fixture.accountIds.push(data.id);
  return { id: data.id, identifier, campaign };
}

const TO_PENDING: Array<[LeadState, LeadState]> = [
  ["sourced", "enriching"],
  ["enriching", "qualifying"],
  ["qualifying", "qualified"],
  ["qualified", "verifying"],
  ["verifying", "drafting"],
  ["drafting", "pending_approval"],
];

type Approved = { leadId: string; email: string; touches: Record<1 | 2 | 3, string>; hash: string };

/** A lead walked to `approved` through lib/state, its 3-step sequence approved for `account` (what approve_email_sequence writes). */
async function approvedLead(n: string, account: Account): Promise<Approved> {
  const domain = `${n}.${TAG}.example.invalid`;
  const { data: company, error: companyError } = await db
    .from("companies")
    .insert({ name: `U9 Fixture ${n}`, domain, country: "LT", segment: "test" })
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
      timezone: "Europe/Vilnius",
      state: "sourced",
    })
    .select("id")
    .single();
  if (leadError || !lead) throw new Error(`fixture lead: ${leadError?.message}`);
  fixture.leadIds.push(lead.id);
  for (const [from, to] of TO_PENDING) await state.transition(lead.id, from, to, "test_u9_fixture", { tag: TAG });

  const { data: rows, error } = await db
    .from("touches")
    .insert(
      ([1, 2, 3] as const).map((step) => ({
        lead_id: lead.id,
        step_no: step,
        channel: "email",
        direction: "outbound",
        status: "pending_approval",
        subject: step === 1 ? "Your listing pages" : null,
        draft_body: STEP_BODIES[step],
        prompt_version: 10,
        send_account_id: account.id,
      })),
    )
    .select("id, step_no, channel, subject, draft_body, prompt_version");
  if (error || !rows || rows.length !== 3) throw new Error(`fixture touches: ${error?.message}`);
  fixture.touchIds.push(...rows.map((r) => r.id));
  const touches = [...rows].sort((a, b) => (a.step_no ?? 0) - (b.step_no ?? 0)).map((t) => ({ ...t, body: t.draft_body }));
  const { data: sender } = await db.from("send_accounts").select("id, signature_text, instantly_campaign_id").eq("id", account.id).single();
  const snapshot = buildSequenceApprovalSnapshot({
    lead: { id: lead.id, email },
    sender: sender!,
    sequence: { version: 1, value: EMAIL_SEQUENCE },
    touches,
  });
  const hash = sequenceApprovalHash(snapshot);
  for (const t of touches) {
    const { error: approveError } = await db
      .from("touches")
      .update({
        body: t.body,
        status: "approved",
        approval_hash: hash,
        approval_snapshot: snapshot as never,
        approved_at: new Date().toISOString(),
        approved_by: "test:u9",
      })
      .eq("id", t.id);
    if (approveError) throw new Error(`fixture approve: ${approveError.message}`);
  }
  await state.transition(lead.id, "pending_approval", "approved", "approved", { touch_id: touches[0]!.id, source: "test" });
  const byStep = Object.fromEntries(touches.map((t) => [t.step_no!, t.id])) as Record<1 | 2 | 3, string>;
  return { leadId: lead.id, email, touches: byStep, hash };
}

async function leadState(id: string): Promise<string | null> {
  const { data } = await db.from("leads").select("state").eq("id", id).single();
  return data?.state ?? null;
}

async function tagJobs(): Promise<Array<{ id: string; type: string; state: string; attempts: number; payload: unknown; idempotency_key: string | null }>> {
  const { data, error } = await jobsDb.from("jobs").select("id, type, state, attempts, payload, idempotency_key").like("type", `${TAG}.%`);
  if (error) throw new Error(`tag jobs: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function pauseAndCampaigns(): Promise<void> {
  const active = await createAccount("active");
  const pausedCampaign = await createAccount("pcamp");
  const pausedAccount = await createAccount("pacct", { health: "paused" });
  const la = await approvedLead("la", active);
  const lp = await approvedLead("lp", pausedCampaign);
  const lx = await approvedLead("lx", pausedAccount);
  const ls = await approvedLead("ls", active);
  // Step 1 killed, steps 2–3 still approved: nothing may be enqueued for it.
  await db.from("touches").update({ status: "killed" }).eq("id", ls.touches[1]);
  fixtureLeadIds = [la.leadId, lp.leadId, lx.leadId, ls.leadId];

  // Send jobs already queued before the pause (defence in depth: preflight must refuse them).
  await enqueueSend({ queue: mappedQueue }, { id: lp.touches[1], approval_hash: lp.hash });
  await enqueueSend({ queue: mappedQueue }, { id: lx.touches[1], approval_hash: lx.hash });

  console.log("\n--- G1: global pause → orchestrate makes zero provider calls; safety still runs ---");
  const reg = testRegistry("g");
  setPause(true, [pausedCampaign.campaign]);
  const beforeJobs = await tagJobs();
  const paused = await runOrchestrate(cronDeps(reg));
  const afterJobs = await tagJobs();
  assert("G1: {paused:true, claimed:0, completed:0, failed:0}", paused.paused === true && paused.claimed === 0 && paused.completed === 0 && paused.failed === 0, JSON.stringify(paused));
  assert("G1: every adapter mock uncalled (0 provider calls)", providerCalls() === 0 && mock.enroll.length === 0, JSON.stringify(adapters));
  assert("G1: no registry built, no stage runner called", registryBuilds === 0 && runnerCalls.length === 0);
  assert(
    "G1: no job enqueued; the queued sends stay queued with 0 attempts",
    afterJobs.length === beforeJobs.length && afterJobs.every((j) => j.state === "queued" && j.attempts === 0),
    JSON.stringify(afterJobs.map((j) => [j.type.slice(TAG.length + 1), j.state, j.attempts])),
  );

  await realQueue.enqueue({ type: T_RECIPIENT, payload: {} });
  const safety = await runSafety(cronDeps(reg));
  assert(
    "G1: safety (still paused) enqueues the 3 sweeps and runs them + the queued recipient check",
    safety.claimed === 4 && safety.completed === 4 && Object.values(safety.enqueued).every((v) => v === "enqueued"),
    JSON.stringify({ claimed: safety.claimed, completed: safety.completed, enqueued: safety.enqueued }),
  );
  assert("G1: safety ran only safety types", [...handled].sort().join() === [T_RECIPIENT, ...T_SWEEPS].sort().join(), handled.join());
  const safetyAgain = await runSafety(cronDeps(reg));
  assert("G1: a duplicate safety delivery in the bucket dedupes the sweeps", Object.values(safetyAgain.enqueued).every((v) => v === "deduped") && safetyAgain.claimed === 0, JSON.stringify(safetyAgain.enqueued));
  assert("G1: the send jobs never ran while paused", !(await tagJobs()).some((j) => j.type === T_SEND && j.state !== "queued"));

  console.log("\n--- C1: paused campaign refused while an active sender's lead enrolls exactly once (same run) ---");
  setPause(false, [pausedCampaign.campaign]);
  handled.length = 0;
  const run = await runOrchestrate(cronDeps(reg));
  if (run.paused) throw new Error("unexpected paused run");
  const outLa = sendOutcomes.get(la.touches[1]);
  const outLp = sendOutcomes.get(lp.touches[1]);
  const outLx = sendOutcomes.get(lx.touches[1]);
  assert(
    "C1: orchestrate {claimed, completed, failed} — 5 stage jobs + 3 send jobs, none failed",
    run.claimed === 8 && run.completed === 8 && run.failed === 0,
    JSON.stringify({ claimed: run.claimed, completed: run.completed, failed: run.failed, byType: run.byType }),
  );
  assert("C1: the active sender's lead enrolled exactly once", outLa?.kind === "sent" && mock.enroll.length === 1 && mock.enroll[0]!.lead.email === la.email, JSON.stringify(outLa));
  assert(
    "C1: the paused campaign's queued send → deferred campaign_paused, no enroll",
    outLp?.kind === "deferred" && outLp.verdicts.map((v) => v.reason).join() === "campaign_paused",
    JSON.stringify(outLp),
  );
  const deferredAt = outLp?.kind === "deferred" ? Date.parse(outLp.runAfter) : NaN;
  assert("C1: a pause deferral waits ≥ 1 h", deferredAt - INSIDE.getTime() >= 3_600_000, outLp?.kind === "deferred" ? outLp.runAfter : "");
  assert(
    "C1: the paused account's queued send → refused sender_unhealthy (hold), no provider read",
    outLx?.kind === "refused" && outLx.verdicts.some((v) => v.reason === "sender_unhealthy") && !mock.health.some((h) => h.includes(pausedAccount.identifier)),
    JSON.stringify(outLx),
  );
  assert("C1: states — la left approved, lp and lx still approved", (await leadState(la.leadId)) !== "approved" && (await leadState(lp.leadId)) === "approved" && (await leadState(lx.leadId)) === "approved");

  const sendJobs = (await tagJobs()).filter((j) => j.type === T_SEND);
  const sendTouchIds = sendJobs.map((j) => (j.payload as { touch_id: string }).touch_id);
  const { data: sendTouches } = await db.from("touches").select("id, step_no").in("id", sendTouchIds);
  assert(
    "C1: every send job is a step-1 touch (step ≥ 2 never enqueued)",
    sendTouchIds.length > 0 && (sendTouches ?? []).length === new Set(sendTouchIds).size && (sendTouches ?? []).every((t) => t.step_no === 1),
    JSON.stringify(sendTouches),
  );
  assert("C1: nothing enqueued for the lead whose step 1 is killed", !sendTouchIds.some((id) => Object.values(ls.touches).includes(id)));
  assert(
    "C1: stage limits passed through; qualify (limit 0) not enqueued",
    run.enqueued.qualify === "disabled" &&
      JSON.stringify(runnerCalls.map((c) => [c.stage, c.limit]).sort()) ===
        JSON.stringify([["draft", 1], ["enrich", 3], ["send_enqueue", 5], ["source", 2], ["verify", 4]]),
    JSON.stringify(runnerCalls),
  );
  assert("C1: no stage job row for the disabled stage", !(await tagJobs()).some((j) => j.type === reg.types.qualify));

  console.log("\n--- C2: send_enqueue skips + never re-enqueues ---");
  const again = await runSendEnqueueStage(
    { db, queue: mappedQueue, readPause: () => readOperationsPause(getActiveSetting) },
    { limit: 5, leadIds: fixtureLeadIds },
  );
  assert(
    "C2: second pass — 0 enqueued; paused campaign and paused sender skipped; killed step 1 skipped",
    again.enqueued === 0 && again.skipped.campaign_paused === 1 && again.skipped.sender_paused === 1 && again.skipped.no_step1_touch === 1,
    JSON.stringify(again),
  );
  assert("C2: still exactly one enroll call", mock.enroll.length === 1);
  setPause(false, []);
  const resumed = await runSendEnqueueStage(
    { db, queue: mappedQueue, readPause: () => readOperationsPause(getActiveSetting) },
    { limit: 5, leadIds: fixtureLeadIds },
  );
  assert("C2: campaign resumed → lp's send dedupes onto its first job (no second job)", resumed.enqueued === 0 && resumed.already_enqueued === 1, JSON.stringify(resumed));
}

async function concurrency(): Promise<void> {
  console.log("\n--- S1: two concurrent orchestrate calls → each stage runs once per bucket (real claim_jobs) ---");
  setPause(false, []);
  runnerCalls.length = 0;
  fixtureLeadIds = [];
  const reg = testRegistry("c", { runnerDelayMs: 50 });
  const [a, b] = await Promise.all([runOrchestrate(cronDeps(reg)), runOrchestrate(cronDeps(reg))]);
  const enabled = STAGE_ORDER.filter((s) => s !== "qualify");
  const perStage = enabled.map((s) => runnerCalls.filter((c) => c.stage === s).length);
  assert("S1: each enabled stage ran exactly once", perStage.every((n) => n === 1), JSON.stringify(Object.fromEntries(enabled.map((s, i) => [s, perStage[i]]))));
  const rows = (await tagJobs()).filter((j) => j.type.startsWith(`${TAG}.c.stage.`));
  assert("S1: one job row per enabled stage", rows.length === enabled.length, String(rows.length));
  const kinds = enabled.map((s) => [a, b].map((r) => (r.paused ? "paused" : r.enqueued[s])).sort().join("/"));
  assert("S1: one run enqueued each stage, the other deduped", kinds.every((k) => k === "deduped/enqueued"), kinds.join(","));
  const third = await runOrchestrate(cronDeps(reg));
  assert("S1: a duplicate cron delivery in the same bucket runs nothing", !third.paused && third.claimed === 0 && runnerCalls.length === enabled.length, JSON.stringify(third));
}

async function daily(): Promise<void> {
  console.log("\n--- D1: daily — ramp_stage, bounce_rate_7d + auto-pause, idempotent ---");
  const today = ledgerDate(NOW);
  const daysAgo = (n: number) => ledgerDate(new Date(NOW.getTime() - n * 86_400_000));
  const notStarted = await createAccount("d-warm", { rampStartedOn: null, rampStage: "full" });
  const ramping = await createAccount("d-ramp", { rampStartedOn: daysAgo(5) });
  const full = await createAccount("d-full", { rampStartedOn: daysAgo(20) });
  const bouncy = await createAccount("d-bouncy", { rampStartedOn: daysAgo(1) });
  const pausedAcct = await createAccount("d-paused", { health: "paused", rampStartedOn: today, rampStage: "ramp1" });
  const ids = [notStarted.id, ramping.id, full.id, bouncy.id, pausedAcct.id];

  // Sends in the last 7 days: ramping 10 sent / 0 bounced; bouncy 20 sent / 1 bounced (5% > 3%).
  const carrier = await approvedLead("d-carrier", ramping);
  const sends = (account: Account, total: number, bounced: number) =>
    Array.from({ length: total }, (_, i) => ({
      lead_id: carrier.leadId,
      step_no: 1,
      channel: "email",
      direction: "outbound",
      status: i < bounced ? "bounced" : "sent",
      body: "fixture",
      send_account_id: account.id,
      sent_at: new Date(NOW.getTime() - 86_400_000).toISOString(),
    }));
  const { error: sendError } = await db.from("touches").insert([...sends(ramping, 10, 0), ...sends(bouncy, 20, 1)]);
  if (sendError) throw new Error(`fixture sends: ${sendError.message}`);
  // A reservation left `reserved` yesterday (a crash between reserve and dispatch).
  await ledger.reserve({ sendAccountId: ramping.id, date: daysAgo(1), quota: 15, idempotencyKey: `${TAG}.stale` });

  const dailyDeps = {
    db: hookDb,
    instantly: {
      pauseCampaign: async (id: string) => {
        mock.pauseCampaign.push(id);
        return { id, name: "paused", status: 2, timestamp_created: NOW.toISOString() } as never;
      },
      deleteLead: async () => {
        throw new Error("no deleteLead expected");
      },
      getLead: async () => null,
      findLeadInCampaign: async () => null,
    },
    transition: state.transition,
    getActiveSetting,
    alert: async (text: string) => {
      mock.alerts.push(text);
    },
    now: () => NOW,
  };
  const snapshot = async () => {
    const { data } = await db.from("send_accounts").select("id, ramp_stage, health, bounce_rate_7d, paused_reason").in("id", ids).order("id");
    return JSON.stringify(data);
  };

  const first = await runDaily(dailyDeps, { accountIds: ids });
  const byId = new Map(first.results.map((r) => [r.send_account_id, r]));
  assert(
    "D1: ramp_stage warmup / ramp2 / full / ramp1 by the capacity_defaults ramp",
    byId.get(notStarted.id)?.ramp_stage === "warmup" &&
      byId.get(ramping.id)?.ramp_stage === "ramp2" &&
      byId.get(full.id)?.ramp_stage === "full" &&
      byId.get(bouncy.id)?.ramp_stage === "ramp1",
    JSON.stringify(first.results.map((r) => r.ramp_stage)),
  );
  assert("D1: bounce_rate_7d recomputed for the non-paused accounts only", first.bounce_checked === 4 && byId.get(pausedAcct.id)?.bounce_checked === false);
  assert("D1: 0/10 → rate 0; no sends → null (unknown, never zero)", byId.get(ramping.id)?.bounce_rate_7d === 0 && byId.get(full.id)?.bounce_rate_7d === null);
  assert(
    "D1: 1/20 = 5% > 3% → auto-paused via checkBounceRate (campaign pause ×1, alert)",
    byId.get(bouncy.id)?.auto_paused === true && mock.pauseCampaign.length === 1 && mock.pauseCampaign[0] === bouncy.campaign,
    JSON.stringify(byId.get(bouncy.id)),
  );
  assert("D1: the stale reservation is counted, not touched", first.stale_reserved === 1 && first.failed === 0, JSON.stringify({ stale: first.stale_reserved, failed: first.failed }));

  const afterFirst = await snapshot();
  const second = await runDaily(dailyDeps, { accountIds: ids });
  const afterSecond = await snapshot();
  assert("D1: second run changes nothing (ramp_changed 0, same rows, no second pause)", second.ramp_changed === 0 && afterFirst === afterSecond && mock.pauseCampaign.length === 1, `${first.ramp_changed} → ${second.ramp_changed}`);
  const { data: stale } = await db.from("capacity_reservations").select("state").eq("idempotency_key", `${TAG}.stale`).single();
  assert("D1: the stale reservation is still `reserved`", stale?.state === "reserved");
}

// ---------------------------------------------------------------------------
// Counts, cleanup, main
// ---------------------------------------------------------------------------

const TABLES = [
  "companies",
  "leads",
  "touches",
  "lead_events",
  "send_accounts",
  "capacity_ledger",
  "capacity_reservations",
  "outbox",
  "jobs",
  "instantly_enrollments",
  "exceptions",
  "settings",
] as const;

async function countRows(table: (typeof TABLES)[number]): Promise<number> {
  const { count, error } = await (enrollDb as unknown as SupabaseClient<DatabaseWithWebhooks>)
    .from(table as "leads")
    .select("*", { count: "exact", head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

async function cleanup(): Promise<void> {
  const del = async (label: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await run();
    if (error) console.error(`cleanup ${label}: ${error.message}`);
  };
  await del("jobs(type)", () => jobsDb.from("jobs").delete().like("type", `${TAG}.%`));
  if (fixture.leadIds.length) {
    await del("outbox", () => db.from("outbox").delete().in("lead_id", fixture.leadIds));
    await del("instantly_enrollments", () => enrollDb.from("instantly_enrollments").delete().in("lead_id", fixture.leadIds));
    await del("touches", () => db.from("touches").delete().in("lead_id", fixture.leadIds));
    await del("lead_events", () => db.from("lead_events").delete().in("lead_id", fixture.leadIds));
    await del("exceptions(lead)", () => hookDb.from("exceptions").delete().in("lead_id", fixture.leadIds));
    await del("leads", () => db.from("leads").delete().in("id", fixture.leadIds));
  }
  if (fixture.companyIds.length) await del("companies", () => db.from("companies").delete().in("id", fixture.companyIds));
  if (fixture.accountIds.length) await del("send_accounts", () => db.from("send_accounts").delete().in("id", fixture.accountIds));
}

async function main(): Promise<void> {
  console.log(`\n=== test-u9-orchestrator (tag=${TAG}) ===`);
  const before: Record<string, number> = {};
  for (const t of TABLES) before[t] = await countRows(t);
  console.log(`BEFORE  ${TABLES.map((t) => `${t}=${before[t]}`).join(" ")}`);
  guardFetch();
  try {
    await pauseAndCampaigns();
    await concurrency();
    await daily();
  } catch (error) {
    assert("no unexpected exception", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    await cleanup();
    console.log("\nCleanup: fixture rows removed.");
  }
  globalThis.fetch = realFetch;
  const after: Record<string, number> = {};
  for (const t of TABLES) after[t] = await countRows(t);
  console.log(`AFTER   ${TABLES.map((t) => `${t}=${after[t]}`).join(" ")}`);
  for (const t of TABLES) assert(`${t} count unchanged`, before[t] === after[t], `${before[t]} → ${after[t]}`);
  assert("network guard: 0 non-Supabase calls", network.length === 0, network.join(", "));

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${results.length} check(s) FAILED.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} checks passed.`);
}

main().catch((error: unknown) => {
  console.error("test-u9-orchestrator crashed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
