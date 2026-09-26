import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { JobQueue, JobRow } from "@/lib/jobs/queue";
import { defineJob, DuplicateJobTypeError, type RegisteredJob } from "@/lib/jobs/registry";
import { CLASSIFY_REPLY_JOB_TYPE, SAFETY_JOB_TYPES, STAGE_JOB_TYPES, type StageName } from "@/lib/jobs/types";
import { engineTimings, instantlySequencePayload } from "@/lib/sending/campaign-sequence";
import { DEFERRABLE_REFUSALS, preflight, type PreflightContext } from "@/lib/sending/preflight";
import { buildSequenceApprovalSnapshot, sequenceApprovalHash, type EmailSequence, type SequenceTouch } from "@/lib/sending/sequence-approval";
import { orchestrator_budgets } from "@/lib/settings/seed-content";
import { handleTelegramWebhook, processTelegramUpdate, type TelegramHandlerDeps } from "@/lib/telegram/handler";
import { z } from "zod";

import { rampStage } from "./daily";
import { applyPauseChange, readOperationsPause, readOrchestratorBudgets } from "./pause";
import { buildJobRegistry, partitionTypes } from "./registry";
import { handleCronRequest, runOrchestrate, runSafety, SWEEP_JOB_TYPES, type CronDeps } from "./run";
import { bucketOf, runStageJob, STAGE_ORDER, stageJobDefinitions, type StageJobDeps } from "./stages";

// Pure suite for U9 (09 §U9 DoD): cron auth, the global pause (zero provider
// calls, safety still runs), stage budgets and single-flight, the drain's
// pause/budget/cap rules, preflight pause rows, the ramp_stage mapping, the
// pause writer, and the Telegram secret + /pause /resume. No DB, no network:
// an in-memory queue with the same dedupe/lease/fence semantics as queue.ts.

// ---------------------------------------------------------------------------
// Network guard: any fetch fails the suite.
// ---------------------------------------------------------------------------

const network: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const target = String(input instanceof Request ? input.url : input);
    network.push(target);
    throw new Error(`unexpected network call: ${target}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(network, [], "no network call may escape");
});

// ---------------------------------------------------------------------------
// In-memory queue (queue.ts semantics: key dedupe, one lease per claim, fenced writes)
// ---------------------------------------------------------------------------

function memoryQueue() {
  const rows: JobRow[] = [];
  const nowIso = () => new Date().toISOString();
  const queue: JobQueue = {
    async get(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async enqueue(input) {
      const existing = input.idempotencyKey ? rows.find((r) => r.idempotency_key === input.idempotencyKey) : undefined;
      if (existing) return { job: existing, deduped: true };
      const row: JobRow = {
        id: randomUUID(),
        type: input.type,
        payload: input.payload ?? {},
        state: "queued",
        run_after: input.runAfter ?? new Date(Date.now() - 1).toISOString(),
        lease_owner: null,
        lease_expires_at: null,
        attempts: 0,
        max_attempts: input.maxAttempts ?? 5,
        last_error: null,
        idempotency_key: input.idempotencyKey ?? null,
        finished_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      rows.push(row);
      return { job: row, deduped: false };
    },
    async claim(input) {
      const limit = input.limit ?? 1;
      const out: JobRow[] = [];
      for (const row of rows) {
        if (out.length >= limit) break;
        if (row.state !== "queued" || !input.types.includes(row.type) || Date.parse(row.run_after) > Date.now()) continue;
        row.state = "leased";
        row.lease_owner = input.owner;
        row.attempts += 1;
        row.lease_expires_at = new Date(Date.now() + (input.leaseSeconds ?? 300) * 1000).toISOString();
        out.push({ ...row });
      }
      return out;
    },
    async complete(job, owner) {
      const row = rows.find((r) => r.id === job.id);
      if (!row || row.state !== "leased" || row.lease_owner !== owner || row.attempts !== job.attempts) return "lease_lost";
      Object.assign(row, { state: "done", lease_owner: null, lease_expires_at: null, finished_at: nowIso() });
      return "ok";
    },
    async fail(job, owner, errorMessage, options) {
      const row = rows.find((r) => r.id === job.id);
      const dead = options.permanent === true || job.attempts >= job.max_attempts;
      if (!row || row.state !== "leased" || row.lease_owner !== owner || row.attempts !== job.attempts) {
        return { result: "lease_lost", state: dead ? "dead" : "queued" };
      }
      Object.assign(row, dead
        ? { state: "dead", lease_owner: null, lease_expires_at: null, last_error: errorMessage }
        : { state: "queued", lease_owner: null, lease_expires_at: null, last_error: errorMessage, run_after: options.runAfter });
      return { result: "ok", state: dead ? "dead" : "queued" };
    },
    async cancel(id) {
      const row = rows.find((r) => r.id === id && r.state === "queued");
      if (row) row.state = "cancelled";
      return Boolean(row);
    },
  };
  const countLeased: StageJobDeps["countLeased"] = async (type, excludeId) =>
    rows.filter((r) => r.type === type && r.state === "leased" && r.id !== excludeId).length;
  return { queue, rows, countLeased };
}

// ---------------------------------------------------------------------------
// Settings mock (stateful: /pause writes are read back)
// ---------------------------------------------------------------------------

type Row = { version: number; value: unknown };

function settingsMock(initial: Record<string, Row | "throw"> = {}) {
  const rows = new Map<string, Row | "throw">(Object.entries(initial));
  const writes: Array<{ key: string; value: unknown; changedBy: string; note: string }> = [];
  return {
    writes,
    rows,
    getActiveSetting: async (key: string): Promise<Row> => {
      const row = rows.get(key);
      if (row === "throw") throw new Error(`Failed to fetch setting "${key}": connection reset`);
      if (!row) throw new Error(`No active setting found for key "${key}"`);
      return row;
    },
    writeNewVersion: async (key: string, value: unknown, changedBy: string, note: string) => {
      const current = rows.get(key);
      const version = (current && current !== "throw" ? current.version : 0) + 1;
      rows.set(key, { version, value });
      writes.push({ key, value, changedBy, note });
      return { version, value };
    },
  };
}

const PAUSED = { version: 3, value: { global: true, reason: "operator test", paused_campaign_ids: [] } };
const RUNNING = { version: 3, value: { global: false, reason: null, paused_campaign_ids: [] } };
const budgets = (stages: Partial<(typeof orchestrator_budgets)["stages"]> = {}, rest: Partial<typeof orchestrator_budgets> = {}) => ({
  version: 2,
  value: {
    ...orchestrator_budgets,
    run_budget_ms: 240_000,
    safety_budget_ms: 240_000,
    ...rest,
    stages: { source: 1, enrich: 2, qualify: 3, verify: 4, draft: 5, send_enqueue: 6, classify: 10, ...stages },
  },
});

// ---------------------------------------------------------------------------
// A mock engine: stage runners and job handlers that call counting "adapters"
// ---------------------------------------------------------------------------

type Adapters = Record<"apollo" | "apify" | "anthropic" | "millionverifier" | "instantly" | "telegram", number>;

function engine(opts: { runnerDelayMs?: number } = {}) {
  const mem = memoryQueue();
  const adapters: Adapters = { apollo: 0, apify: 0, anthropic: 0, millionverifier: 0, instantly: 0, telegram: 0 };
  const runnerCalls: Array<{ stage: StageName; limit: number }> = [];
  const handled: string[] = [];
  let registryBuilt = 0;
  const call = (stage: StageName, adapter: keyof Adapters) => async ({ limit }: { limit: number }) => {
    runnerCalls.push({ stage, limit });
    adapters[adapter] += 1;
    if (opts.runnerDelayMs) await new Promise((r) => setTimeout(r, opts.runnerDelayMs));
    return { ok: true };
  };
  const job = (type: string, adapter: keyof Adapters, timeoutMs = 45_000): RegisteredJob =>
    defineJob({
      type,
      payloadSchema: z.unknown(),
      timeoutMs,
      handler: async () => {
        handled.push(type);
        adapters[adapter] += 1;
      },
    });
  let pauseRead: () => Promise<{ global: boolean }> = async () => ({ global: false });
  const stageDeps: StageJobDeps = {
    runners: {
      source: call("source", "apollo"),
      enrich: call("enrich", "apify"),
      qualify: call("qualify", "anthropic"),
      verify: call("verify", "millionverifier"),
      draft: call("draft", "anthropic"),
      send_enqueue: call("send_enqueue", "instantly"),
    },
    countLeased: mem.countLeased,
    readPause: async () => ({ ...(await pauseRead()), reason: null, paused_campaign_ids: [], version: 1, source: "setting" }),
  };
  const registry = () => {
    registryBuilt += 1;
    return buildJobRegistry({
      send: [job("send.email", "instantly"), job("send.reconcile", "instantly"), job("send.recipient_check", "instantly", 90_000)],
      reconcile: SWEEP_JOB_TYPES.map((t) => job(t, "instantly", 120_000)),
      classify: [job(CLASSIFY_REPLY_JOB_TYPE, "anthropic", 150_000)],
      research: [job("research.company", "apify", 120_000)],
      stages: stageJobDefinitions(stageDeps),
    });
  };
  return {
    ...mem,
    adapters,
    runnerCalls,
    handled,
    registry,
    stageDeps,
    get registryBuilt() {
      return registryBuilt;
    },
    setPauseRead(fn: () => Promise<{ global: boolean }>) {
      pauseRead = fn;
    },
  };
}

const totalCalls = (a: Adapters) => Object.values(a).reduce((s, n) => s + n, 0);

// ---------------------------------------------------------------------------
// Cron auth
// ---------------------------------------------------------------------------

describe("cron auth (Bearer CRON_SECRET)", () => {
  const SECRET = `test-cron-${randomUUID()}`;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  const run = async () => ({ claimed: 2, completed: 2, failed: 0 });

  test("401 without Authorization, 401 with a wrong bearer, 200 with the right one", async () => {
    let runs = 0;
    const counted = async () => {
      runs += 1;
      return run();
    };
    const none = await handleCronRequest(new Request("https://x.example.com/api/cron/orchestrate"), counted);
    assert.equal(none.status, 401);
    const wrong = await handleCronRequest(
      new Request("https://x.example.com/api/cron/orchestrate", { headers: { Authorization: "Bearer nope" } }),
      counted,
    );
    assert.equal(wrong.status, 401);
    assert.equal(runs, 0, "an unauthorized request never runs");
    const ok = await handleCronRequest(
      new Request("https://x.example.com/api/cron/orchestrate", { headers: { Authorization: `Bearer ${SECRET}` } }),
      counted,
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { claimed: 2, completed: 2, failed: 0 });
  });

  test("CRON_SECRET unset → 401 even with a bearer", async () => {
    delete process.env.CRON_SECRET;
    const res = await handleCronRequest(
      new Request("https://x.example.com/api/cron/daily", { headers: { Authorization: "Bearer undefined" } }),
      run,
    );
    assert.equal(res.status, 401);
  });

  test("a run that throws → 500 with no detail", async () => {
    const res = await handleCronRequest(
      new Request("https://x.example.com/api/cron/safety", { headers: { Authorization: `Bearer ${SECRET}` } }),
      async () => {
        throw new Error("secret detail");
      },
    );
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Run failed" });
  });

  test("the full orchestrate path returns {claimed, completed, failed}", async () => {
    const e = engine();
    const s = settingsMock({ operations_pause: RUNNING, orchestrator_budgets: budgets() });
    const res = await handleCronRequest(
      new Request("https://x.example.com/api/cron/orchestrate", { headers: { Authorization: `Bearer ${SECRET}` } }),
      () => runOrchestrate({ queue: e.queue, registry: e.registry, getActiveSetting: s.getActiveSetting }),
    );
    const body = (await res.json()) as { claimed: number; completed: number; failed: number };
    assert.equal(res.status, 200);
    assert.equal(body.claimed, 6);
    assert.equal(body.completed, 6);
    assert.equal(body.failed, 0);
  });
});

// ---------------------------------------------------------------------------
// Global pause
// ---------------------------------------------------------------------------

describe("global pause", () => {
  test("orchestrate: zero provider calls, nothing enqueued, registry never built; safety still runs", async () => {
    const e = engine();
    const s = settingsMock({ operations_pause: PAUSED, orchestrator_budgets: budgets() });
    // A send, a classify and a research job were queued before the pause.
    await e.queue.enqueue({ type: "send.email", payload: {} });
    await e.queue.enqueue({ type: CLASSIFY_REPLY_JOB_TYPE, payload: {} });
    await e.queue.enqueue({ type: "research.company", payload: {} });
    // A recipient check the webhook queued.
    await e.queue.enqueue({ type: "send.recipient_check", payload: {} });

    const result = await runOrchestrate({ queue: e.queue, registry: e.registry, getActiveSetting: s.getActiveSetting });
    assert.deepEqual(result, { paused: true, reason: "operator test", claimed: 0, completed: 0, failed: 0 });
    assert.equal(totalCalls(e.adapters), 0, "every adapter mock uncalled");
    assert.equal(e.runnerCalls.length, 0);
    assert.equal(e.registryBuilt, 0, "no registry, so no provider client, is built while paused");
    assert.equal(e.rows.filter((r) => r.type.startsWith("stage.")).length, 0, "no stage job enqueued");
    assert.ok(e.rows.filter((r) => r.type !== "send.recipient_check").every((r) => r.state === "queued" && r.attempts === 0), "no attempt burned");

    const safety = await runSafety({ queue: e.queue, registry: e.registry, getActiveSetting: s.getActiveSetting });
    assert.deepEqual(Object.values(safety.enqueued), ["enqueued", "enqueued", "enqueued"]);
    assert.equal(safety.claimed, 4, "3 sweeps + the recipient check");
    assert.equal(safety.completed, 4);
    assert.deepEqual([...e.handled].sort(), ["reconcile.instantly_leads", "reconcile.reply_poll", "reconcile.stale_stop", "send.recipient_check"]);
    assert.ok(!e.handled.includes("send.email") && !e.handled.includes(CLASSIFY_REPLY_JOB_TYPE) && !e.handled.includes("research.company"));
  });

  test("missing operations_pause row = not paused; unreadable = paused (fail closed)", async () => {
    const missing = await readOperationsPause(settingsMock().getActiveSetting);
    assert.equal(missing.global, false);
    assert.equal(missing.source, "missing");
    const broken = await readOperationsPause(settingsMock({ operations_pause: "throw" }).getActiveSetting);
    assert.equal(broken.global, true);
    assert.equal(broken.source, "unreadable");
    const invalid = await readOperationsPause(settingsMock({ operations_pause: { version: 1, value: { global: "yes" } } }).getActiveSetting);
    assert.equal(invalid.global, true);
  });

  test("a pause flipped mid-run stops the drain; the rest stay queued with no attempt burned", async () => {
    const e = engine();
    const s = settingsMock({ operations_pause: RUNNING, orchestrator_budgets: budgets() });
    for (let i = 0; i < 3; i++) await e.queue.enqueue({ type: "send.email", payload: { i } });
    let reads = 0;
    const getActiveSetting = async (key: string) => {
      if (key === "operations_pause") {
        reads += 1;
        // Read 1: run start. Read 2: before claim #1. Then paused.
        return reads <= 2 ? RUNNING : PAUSED;
      }
      return s.getActiveSetting(key);
    };
    const result = await runOrchestrate({ queue: e.queue, registry: e.registry, getActiveSetting });
    assert.equal(result.paused, false);
    assert.equal(result.claimed, 1);
    assert.equal(result.paused === false && result.stoppedReason, "paused");
    const untouched = e.rows.filter((r) => r.state === "queued");
    assert.equal(untouched.length, 2 + 6, "2 sends + the 6 stage jobs still queued");
    assert.ok(untouched.every((r) => r.attempts === 0));
  });

  test("a stage job that runs while paused completes without running its stage", async () => {
    const e = engine();
    e.setPauseRead(async () => ({ global: true }));
    const outcome = await runStageJob(e.stageDeps, "draft", {
      id: randomUUID(),
      type: STAGE_JOB_TYPES.draft,
      payload: { bucket: bucketOf(new Date()), limit: 3 },
    });
    assert.deepEqual(outcome, { stage: "draft", outcome: "skipped", reason: "paused" });
    assert.equal(e.runnerCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Stage budgets and single-flight
// ---------------------------------------------------------------------------

describe("stage jobs", () => {
  test("limits from orchestrator_budgets reach each stage; limit 0 skips the stage", async () => {
    const e = engine();
    const s = settingsMock({ operations_pause: RUNNING, orchestrator_budgets: budgets({ source: 0, verify: 0 }) });
    const result = await runOrchestrate({ queue: e.queue, registry: e.registry, getActiveSetting: s.getActiveSetting });
    assert.equal(result.paused, false);
    if (result.paused) return;
    assert.equal(result.enqueued.source, "disabled");
    assert.equal(result.enqueued.verify, "disabled");
    assert.deepEqual(
      e.runnerCalls.map((c) => [c.stage, c.limit]).sort(),
      [["draft", 5], ["enrich", 2], ["qualify", 3], ["send_enqueue", 6]].sort(),
    );
    assert.equal(e.adapters.apollo, 0, "source (limit 0) made no Apollo call");
    assert.equal(e.rows.filter((r) => r.type === STAGE_JOB_TYPES.source || r.type === STAGE_JOB_TYPES.verify).length, 0);
    const keys = e.rows.map((r) => r.idempotency_key);
    assert.ok(keys.includes(`stage.enrich:${result.bucket}`));
  });

  test("missing orchestrator_budgets → the seed value (source 0)", async () => {
    const { budgets: b, version } = await readOrchestratorBudgets(settingsMock().getActiveSetting);
    assert.equal(version, null);
    assert.deepEqual(b, orchestrator_budgets);
    const e = engine();
    await runOrchestrate({ queue: e.queue, registry: e.registry, getActiveSetting: settingsMock().getActiveSetting });
    assert.equal(e.runnerCalls.filter((c) => c.stage === "source").length, 0);
    assert.equal(e.runnerCalls.find((c) => c.stage === "enrich")?.limit, orchestrator_budgets.stages.enrich);
  });

  test("two concurrent orchestrate calls → each stage runs once in the bucket", async () => {
    const e = engine({ runnerDelayMs: 15 });
    const s = settingsMock({ operations_pause: RUNNING, orchestrator_budgets: budgets() });
    const deps: CronDeps = { queue: e.queue, registry: e.registry, getActiveSetting: s.getActiveSetting };
    const [a, b] = await Promise.all([runOrchestrate(deps), runOrchestrate(deps)]);
    for (const stage of STAGE_ORDER) {
      assert.equal(e.runnerCalls.filter((c) => c.stage === stage).length, 1, `${stage} ran once`);
    }
    assert.equal(e.rows.filter((r) => r.type.startsWith("stage.")).length, 6, "one row per stage per bucket");
    const statuses = STAGE_ORDER.map((st) => [a, b].map((r) => (r.paused ? null : r.enqueued[st])).sort().join("/"));
    assert.ok(statuses.every((x) => x === "deduped/enqueued"), statuses.join(","));
    // A third (duplicate) cron delivery in the same bucket runs nothing.
    await runOrchestrate(deps);
    assert.equal(e.runnerCalls.length, 6);
  });

  test("a stage job skips when another job of its type holds a lease, or when its bucket is stale", async () => {
    const e = engine();
    await e.queue.enqueue({ type: STAGE_JOB_TYPES.enrich, payload: { bucket: bucketOf(new Date(Date.now() - 300_000)), limit: 2 } });
    await e.queue.claim({ owner: "other-run", types: [STAGE_JOB_TYPES.enrich] });
    const running = await runStageJob(e.stageDeps, "enrich", {
      id: randomUUID(),
      type: STAGE_JOB_TYPES.enrich,
      payload: { bucket: bucketOf(new Date()), limit: 2 },
    });
    assert.deepEqual(running, { stage: "enrich", outcome: "skipped", reason: "already_running" });
    const stale = await runStageJob(e.stageDeps, "qualify", {
      id: randomUUID(),
      type: STAGE_JOB_TYPES.qualify,
      payload: { bucket: bucketOf(new Date(Date.now() - 20 * 60_000)), limit: 2 },
    });
    assert.deepEqual(stale, { stage: "qualify", outcome: "skipped", reason: "stale_bucket" });
    assert.equal(e.runnerCalls.length, 0);
  });

  test("an invalid stage payload (limit 0) is dead-lettered, never run", async () => {
    const e = engine();
    const s = settingsMock({ operations_pause: RUNNING, orchestrator_budgets: budgets({ source: 0, enrich: 0, qualify: 0, verify: 0, draft: 0, send_enqueue: 0 }) });
    await e.queue.enqueue({ type: STAGE_JOB_TYPES.draft, payload: { bucket: bucketOf(new Date()), limit: 0 } });
    const result = await runOrchestrate({ queue: e.queue, registry: e.registry, getActiveSetting: s.getActiveSetting });
    assert.equal(result.paused === false && result.dead, 1);
    assert.equal(e.runnerCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// The drain: classify cap, budget fit, safety split
// ---------------------------------------------------------------------------

describe("drain", () => {
  test("orchestrate never runs a safety type; classify is capped by stages.classify", async () => {
    const e = engine();
    const s = settingsMock({
      operations_pause: RUNNING,
      orchestrator_budgets: budgets({ source: 0, enrich: 0, qualify: 0, verify: 0, draft: 0, send_enqueue: 0, classify: 2 }),
    });
    for (let i = 0; i < 3; i++) await e.queue.enqueue({ type: CLASSIFY_REPLY_JOB_TYPE, payload: { i } });
    await e.queue.enqueue({ type: "send.recipient_check", payload: {} });
    await e.queue.enqueue({ type: "reconcile.reply_poll", payload: {} });
    const result = await runOrchestrate({ queue: e.queue, registry: e.registry, getActiveSetting: s.getActiveSetting });
    assert.equal(result.claimed, 2);
    assert.deepEqual(e.handled, [CLASSIFY_REPLY_JOB_TYPE, CLASSIFY_REPLY_JOB_TYPE]);

    const zero = engine();
    await zero.queue.enqueue({ type: CLASSIFY_REPLY_JOB_TYPE, payload: {} });
    const s0 = settingsMock({
      operations_pause: RUNNING,
      orchestrator_budgets: budgets({ source: 0, enrich: 0, qualify: 0, verify: 0, draft: 0, send_enqueue: 0, classify: 0 }),
    });
    await runOrchestrate({ queue: zero.queue, registry: zero.registry, getActiveSetting: s0.getActiveSetting });
    assert.equal(zero.handled.length, 0, "classify 0 → no classify job runs");
  });

  test("only types whose timeout fits the remaining budget are claimed", async () => {
    const e = engine();
    const s = settingsMock({ operations_pause: RUNNING, orchestrator_budgets: budgets({}, { safety_budget_ms: 60_000 }) });
    const result = await runSafety({ queue: e.queue, registry: e.registry, getActiveSetting: s.getActiveSetting });
    // send.reconcile (45 s) fits in 60 s; the sweeps (120 s) and recipient check (90 s) do not.
    await e.queue.enqueue({ type: "send.reconcile", payload: {} });
    const again = await runSafety({ queue: e.queue, registry: e.registry, getActiveSetting: s.getActiveSetting });
    assert.equal(result.claimed, 0);
    assert.equal(result.stoppedReason, "budget");
    assert.equal(e.rows.filter((r) => r.type.startsWith("reconcile.") && r.state === "queued").length, 3, "the sweeps wait, unclaimed");
    assert.equal(again.claimed, 1);
    assert.deepEqual(e.handled, ["send.reconcile"]);
  });

  test("registry: SAFETY types split from outreach; a duplicate type throws", () => {
    const e = engine();
    const { safety, outreach, missingSafety } = partitionTypes(e.registry());
    assert.deepEqual([...safety].sort(), [...SAFETY_JOB_TYPES].sort());
    assert.deepEqual(missingSafety, []);
    assert.ok(outreach.includes("send.email") && outreach.includes(CLASSIFY_REPLY_JOB_TYPE) && outreach.includes("research.company"));
    assert.ok(Object.values(STAGE_JOB_TYPES).every((t) => outreach.includes(t)));
    const dup = defineJob({ type: "send.email", payloadSchema: z.unknown(), handler: async () => {} });
    assert.throws(() => buildJobRegistry({ send: [dup, dup], reconcile: [], classify: [], research: [], stages: [] }), DuplicateJobTypeError);
  });
});

// ---------------------------------------------------------------------------
// Preflight pause rows
// ---------------------------------------------------------------------------

const SEQUENCE: EmailSequence = {
  steps: [
    { step_no: 1, delay: 0, delay_unit: "days", source: "writer" },
    { step_no: 2, delay: 7, delay_unit: "days", source: "writer" },
    { step_no: 3, delay: 7, delay_unit: "days", source: "template" },
  ],
};

function preflightBase(): PreflightContext {
  const touch = {
    id: "touch-1",
    step_no: 1,
    channel: "email",
    direction: "outbound",
    status: "approved",
    subject: "Your listing pages",
    body: "Hi Test,\n\nA specific observation.\n\nWant the three?",
    prompt_version: 7,
    approval_hash: null as string | null,
    approval_snapshot: { kind: "email_sequence" } as unknown,
  };
  const followups: SequenceTouch[] = [
    { id: "touch-2", step_no: 2, channel: "email", subject: null, body: "A different observation.", prompt_version: 7, status: "approved" },
    { id: "touch-3", step_no: 3, channel: "email", subject: null, body: "Hi Test, I haven't heard back.", prompt_version: 7, status: "approved" },
  ];
  const ctx: PreflightContext = {
    now: new Date("2026-09-29T06:00:00.000Z"), // Tue 09:00 Vilnius, inside the window
    touch,
    sequence: { touches: [touch, ...followups], setting: { version: 1, value: SEQUENCE } },
    campaignSteps: instantlySequencePayload(engineTimings(SEQUENCE))[0]!.steps,
    providerDaily: { dailyLimit: 15, sentToday: 0, followupsDueToday: 0 },
    lead: {
      id: "lead-1",
      state: "approved",
      email: "test.lead@target.example.invalid",
      email_status: "valid",
      email_verified_at: "2026-09-20T00:00:00.000Z",
      timezone: "Europe/Vilnius",
      do_not_contact: false,
      send_account_id: null,
    },
    company: { domain: "target.example.invalid", timezone: null, country: "LT" },
    sender: { id: "acct-1", identifier: "amir@zyndixhq.com", health: "ok", instantly_campaign_id: "camp-1", signature_text: "Amir\nZyndix" },
    providerHealth: { verdict: "healthy", warmupScore: 100 },
    suppression: { email: false, domain: false },
    hasReply: false,
    companyConflicts: 0,
    capacityRemaining: 15,
    policy: { verification_max_age_days: 90, allow_catch_all: false, min_warmup_score: 80, duplicate_company_window_days: 30 },
    windows: {
      priority_days: ["tue", "wed", "thu"],
      secondary_days: ["mon", "fri"],
      window_local: ["08:30", "11:00"],
      secondary_window_local: ["13:30", "16:00"],
      weekend: false,
      jitter_minutes: 17,
    },
  };
  ctx.touch.approval_hash = sequenceApprovalHash(
    buildSequenceApprovalSnapshot({ lead: ctx.lead, sender: ctx.sender, sequence: ctx.sequence!.setting, touches: ctx.sequence!.touches }),
  );
  return ctx;
}

describe("preflight pause rows", () => {
  const reasons = (ctx: PreflightContext) => preflight(ctx).verdicts.map((v) => v.reason);

  test("the base context passes; absent pause = not paused", () => {
    assert.deepEqual(reasons(preflightBase()), []);
    assert.deepEqual(reasons({ ...preflightBase(), pause: { global: false, reason: null, campaignPaused: false } }), []);
  });

  test("global → operations_paused; sender's campaign → campaign_paused; both deferrable", () => {
    assert.deepEqual(reasons({ ...preflightBase(), pause: { global: true, reason: "x", campaignPaused: false } }), ["operations_paused"]);
    assert.deepEqual(reasons({ ...preflightBase(), pause: { global: false, reason: null, campaignPaused: true } }), ["campaign_paused"]);
    assert.deepEqual(reasons({ ...preflightBase(), pause: { global: true, reason: null, campaignPaused: true } }), ["operations_paused", "campaign_paused"]);
    assert.ok(DEFERRABLE_REFUSALS.includes("operations_paused") && DEFERRABLE_REFUSALS.includes("campaign_paused"));
  });

  test("a paused account is still refused (sender_unhealthy), pause or not", () => {
    const ctx = preflightBase();
    ctx.sender.health = "paused";
    ctx.touch.approval_hash = sequenceApprovalHash(
      buildSequenceApprovalSnapshot({ lead: ctx.lead, sender: ctx.sender, sequence: ctx.sequence!.setting, touches: ctx.sequence!.touches }),
    );
    assert.deepEqual(reasons(ctx), ["sender_unhealthy"]);
    assert.ok(!DEFERRABLE_REFUSALS.includes("sender_unhealthy"));
  });
});

// ---------------------------------------------------------------------------
// ramp_stage mapping
// ---------------------------------------------------------------------------

describe("ramp_stage", () => {
  const ramp = { start_quota: 15, max_quota: 30, ramp_step: 5, ramp_every_days: 4 };
  test("warmup (not started) → ramp1 (start quota) → ramp2 → full (max quota)", () => {
    assert.equal(rampStage(ramp, null, "2026-09-26"), "warmup");
    assert.equal(rampStage(ramp, "2026-09-27", "2026-09-26"), "warmup", "a start date in the future is not started");
    assert.equal(rampStage(ramp, "2026-09-26", "2026-09-26"), "ramp1"); // 15
    assert.equal(rampStage(ramp, "2026-09-23", "2026-09-26"), "ramp1"); // day 3: 15
    assert.equal(rampStage(ramp, "2026-09-22", "2026-09-26"), "ramp2"); // day 4: 20
    assert.equal(rampStage(ramp, "2026-09-18", "2026-09-26"), "ramp2"); // day 8: 25
    assert.equal(rampStage(ramp, "2026-09-14", "2026-09-26"), "full"); // day 12: 30
    assert.equal(rampStage({ ...ramp, start_quota: 30 }, "2026-09-26", "2026-09-26"), "full");
  });
});

// ---------------------------------------------------------------------------
// The pause writer and Telegram
// ---------------------------------------------------------------------------

describe("applyPauseChange", () => {
  test("global on writes v+1 and keeps the paused campaigns; a no-op writes nothing", async () => {
    const s = settingsMock({ operations_pause: { version: 4, value: { global: false, reason: null, paused_campaign_ids: ["camp-9"] } } });
    const on = await applyPauseChange(s, { kind: "global", paused: true, reason: "incident" }, "test");
    assert.equal(on.changed, true);
    assert.deepEqual(s.writes[0]!.value, { global: true, reason: "incident", paused_campaign_ids: ["camp-9"] });
    assert.equal((s.rows.get("operations_pause") as Row).version, 5);
    const again = await applyPauseChange(s, { kind: "global", paused: true, reason: "incident" }, "test");
    assert.equal(again.changed, false);
    assert.equal(s.writes.length, 1);
  });

  test("campaign pause adds/removes one id; an unreadable row is never overwritten", async () => {
    const s = settingsMock();
    await applyPauseChange(s, { kind: "campaign", paused: true, campaignId: "camp-2" }, "test");
    assert.deepEqual(s.writes[0]!.value, { global: false, reason: null, paused_campaign_ids: ["camp-2"] });
    await applyPauseChange(s, { kind: "campaign", paused: false, campaignId: "camp-2" }, "test");
    assert.deepEqual(s.writes[1]!.value, { global: false, reason: null, paused_campaign_ids: [] });
    const broken = settingsMock({ operations_pause: "throw" });
    await assert.rejects(applyPauseChange(broken, { kind: "global", paused: false, reason: null }, "test"), /unreadable/);
    assert.equal(broken.writes.length, 0);
  });
});

describe("Telegram webhook secret", () => {
  const SECRET = `tg-${randomUUID()}`;
  const post = (secret?: string) =>
    new Request("https://x.example.com/api/webhooks/telegram", {
      method: "POST",
      headers: secret === undefined ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify({ update_id: 1 }),
    });
  const process = async () => ({ processed: true });
  const handlerDeps = () => {
    throw new Error("handler deps must not be built for a rejected request");
  };

  test("unset → 500, wrong/missing → 401, correct → 200", async () => {
    assert.equal((await handleTelegramWebhook(post(SECRET), { secret: undefined, handlerDeps, process })).status, 500);
    assert.equal((await handleTelegramWebhook(post(SECRET), { secret: "", handlerDeps, process })).status, 500);
    assert.equal((await handleTelegramWebhook(post("wrong"), { secret: SECRET, handlerDeps, process })).status, 401);
    assert.equal((await handleTelegramWebhook(post(`${SECRET}x`), { secret: SECRET, handlerDeps, process })).status, 401);
    assert.equal((await handleTelegramWebhook(post(), { secret: SECRET, handlerDeps, process })).status, 401);
    let built = 0;
    const ok = await handleTelegramWebhook(post(SECRET), {
      secret: SECRET,
      handlerDeps: () => {
        built += 1;
        return {} as TelegramHandlerDeps;
      },
      process,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, processed: true, rejected: false });
    assert.equal(built, 1);
  });
});

describe("Telegram /pause and /resume", () => {
  const OPERATOR = 910_000_901;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TELEGRAM_ALLOWED_USER_IDS;
    process.env.TELEGRAM_ALLOWED_USER_IDS = String(OPERATOR);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = saved;
  });

  function deps(s: ReturnType<typeof settingsMock>, campaigns: string[] = []) {
    const sent: string[] = [];
    const db = {
      from: (table: string) => {
        assert.equal(table, "send_accounts", "only the campaign lookup touches the db");
        let id = "";
        const chain = {
          select: () => chain,
          eq: (_c: string, v: string) => {
            id = v;
            return chain;
          },
          limit: async () => ({ data: campaigns.includes(id) ? [{ id: "acct" }] : [], error: null }),
        };
        return chain;
      },
    };
    const telegram = {
      sendMessage: async (_chat: number, text: string) => {
        sent.push(text);
        return 1;
      },
    };
    const d = {
      db,
      telegram,
      transition: async () => {
        throw new Error("no transition");
      },
      getActiveSetting: s.getActiveSetting,
      writeNewVersion: s.writeNewVersion,
    } as unknown as TelegramHandlerDeps;
    return { d, sent };
  }
  const message = (text: string, from = OPERATOR) => ({ update_id: 7, message: { message_id: 1, from: { id: from }, chat: { id: from }, text } });

  test("/pause writes operations_pause v+1 (global true); /resume v+1 (global false)", async () => {
    const s = settingsMock({ operations_pause: { version: 1, value: { global: false, reason: null, paused_campaign_ids: [] } } });
    const { d, sent } = deps(s);
    await processTelegramUpdate(d, message("/pause"), { skipStore: true });
    assert.equal(s.writes.length, 1);
    assert.equal(s.writes[0]!.key, "operations_pause");
    assert.equal((s.writes[0]!.value as { global: boolean }).global, true);
    assert.equal(s.writes[0]!.changedBy, `telegram:${OPERATOR}`);
    assert.equal((s.rows.get("operations_pause") as Row).version, 2);
    await processTelegramUpdate(d, message("/resume"), { skipStore: true });
    assert.equal(s.writes.length, 2);
    assert.deepEqual(s.writes[1]!.value, { global: false, reason: null, paused_campaign_ids: [] });
    assert.equal((s.rows.get("operations_pause") as Row).version, 3);
    assert.ok(sent[0]!.includes("v2") && sent[1]!.includes("v3"), sent.join(" | "));
    assert.ok(s.writes.every((w) => w.key !== "engine_paused"), "the unread engine_paused key is gone");
  });

  test("a non-allow-listed user cannot pause", async () => {
    const s = settingsMock();
    const { d } = deps(s);
    await processTelegramUpdate(d, message("/pause", 42), { skipStore: true });
    assert.equal(s.writes.length, 0);
  });

  test("/pause campaign <id>: a known campaign is added; an unknown one changes nothing", async () => {
    const s = settingsMock();
    const { d, sent } = deps(s, ["camp-live"]);
    await processTelegramUpdate(d, message("/pause campaign camp-typo"), { skipStore: true });
    assert.equal(s.writes.length, 0);
    assert.ok(sent[0]!.startsWith("Unknown campaign"));
    await processTelegramUpdate(d, message("/pause campaign camp-live"), { skipStore: true });
    assert.deepEqual(s.writes[0]!.value, { global: false, reason: null, paused_campaign_ids: ["camp-live"] });
  });
});
