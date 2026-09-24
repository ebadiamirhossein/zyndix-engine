import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createServiceClient } from "../src/lib/db/service-client";
import { DEFAULT_BACKOFF, computeBackoffMs } from "../src/lib/jobs/backoff";
import { createJobQueue, type JobRow } from "../src/lib/jobs/queue";
import {
  DuplicateJobTypeError,
  PermanentJobError,
  createRegistry,
  defineJob,
} from "../src/lib/jobs/registry";
import { runWorker } from "../src/lib/jobs/worker";
import type { DatabaseWithJobs } from "../src/types/database-extensions";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key) as unknown as SupabaseClient<DatabaseWithJobs>;
const queue = createJobQueue(db);

// ---------------------------------------------------------------------------
// Harness (same shape as test-u1-auth.ts)
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every fixture row carries a type under this prefix, and every claim in this
// script names only such types — so no real job is ever claimed, and cleanup
// deletes exactly what the script created.
const TAG = `test.u2.${Date.now()}`;
const fixtureType = (name: string): string => `${TAG}.${name}`;

async function migrationApplied(): Promise<boolean> {
  // Body select, not head:true — see test-u1-auth.ts migrationApplied().
  const { error } = await db.from("jobs").select("id").limit(1);
  if (!error) {
    return true;
  }
  if (error.code === "PGRST205" || error.message.includes("schema cache")) {
    return false;
  }
  throw new Error(`jobs probe failed: ${error.message}`);
}

async function countRows(table: "leads" | "touches" | "lead_events" | "jobs"): Promise<number> {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) {
    throw new Error(`count ${table} failed: ${error.message}`);
  }
  if (count === null) {
    throw new Error(`count ${table} returned null — does the table exist?`);
  }
  return count;
}

async function cleanup(): Promise<number> {
  const { data, error } = await db.from("jobs").delete().like("type", `${TAG}.%`).select("id");
  if (error) {
    throw new Error(`cleanup failed: ${error.message}`);
  }
  return data?.length ?? 0;
}

async function mustGet(id: string): Promise<JobRow> {
  const row = await queue.get(id);
  if (!row) {
    throw new Error(`fixture job ${id} vanished`);
  }
  return row;
}

async function enqueueMany(type: string, n: number): Promise<JobRow[]> {
  const rows: JobRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push((await queue.enqueue({ type, payload: { i } })).job);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Group 1 — pure: backoff and registry
// ---------------------------------------------------------------------------

async function pureTests(): Promise<void> {
  console.log("--- backoff (pure) ---");
  const noJitter = { jitter: 0 };
  const series = [1, 2, 3, 4, 5, 6, 7, 8, 12, 50].map((a) => computeBackoffMs(a, noJitter));
  assert("attempt 1 waits baseMs", series[0] === DEFAULT_BACKOFF.baseMs, `${series[0]}ms`);
  assert("attempt 2 doubles", series[1] === DEFAULT_BACKOFF.baseMs * 2, `${series[1]}ms`);
  assert(
    "delays are non-decreasing",
    series.every((v, i) => i === 0 || v >= series[i - 1]),
    series.join(","),
  );
  assert("cap is respected at attempt 50", series[9] === DEFAULT_BACKOFF.maxMs, `${series[9]}ms`);
  assert("attempt 0 or negative treated as 1", computeBackoffMs(0, noJitter) === DEFAULT_BACKOFF.baseMs);

  let inBand = true;
  let minSeen = Infinity;
  let maxSeen = -Infinity;
  for (let i = 0; i < 1000; i++) {
    const v = computeBackoffMs(3);
    const centre = DEFAULT_BACKOFF.baseMs * 4;
    minSeen = Math.min(minSeen, v);
    maxSeen = Math.max(maxSeen, v);
    if (v < centre * (1 - DEFAULT_BACKOFF.jitter) - 1 || v > centre * (1 + DEFAULT_BACKOFF.jitter) + 1) {
      inBand = false;
    }
  }
  assert("jitter stays within ±20% over 1000 draws", inBand, `range ${minSeen}..${maxSeen}`);

  let capped = true;
  for (let i = 0; i < 1000; i++) {
    if (computeBackoffMs(40) > DEFAULT_BACKOFF.maxMs) {
      capped = false;
    }
  }
  assert("jitter never pushes past the cap", capped);

  console.log("\n--- registry (pure) ---");
  const echo = defineJob({
    type: "echo",
    payloadSchema: z.object({ n: z.number() }),
    handler: async () => {},
  });
  let dup: unknown = null;
  try {
    createRegistry([echo, echo]);
  } catch (error: unknown) {
    dup = error;
  }
  assert("duplicate job type is rejected", dup instanceof DuplicateJobTypeError);

  const registry = createRegistry([echo]);
  assert("registry lists its types", registry.types().join(",") === "echo");

  let invalid: unknown = null;
  try {
    await registry.get("echo")!.run(
      { id: "x", type: "echo", payload: { n: "not a number" }, attempt: 1, maxAttempts: 5, idempotencyKey: null },
      { signal: new AbortController().signal },
    );
  } catch (error: unknown) {
    invalid = error;
  }
  assert(
    "invalid payload throws PermanentJobError(invalid_payload)",
    invalid instanceof PermanentJobError && invalid.message.startsWith("invalid_payload"),
    invalid instanceof Error ? invalid.message.slice(0, 60) : String(invalid),
  );
}

// ---------------------------------------------------------------------------
// DB groups
// ---------------------------------------------------------------------------

async function dodDisjointClaims(): Promise<void> {
  console.log("\n--- DoD 1: concurrent claim_jobs return disjoint sets ---");
  for (let round = 1; round <= 5; round++) {
    const type = fixtureType(`disjoint.r${round}`);
    await enqueueMany(type, 20);
    const [a, b] = await Promise.all([
      queue.claim({ owner: `${TAG}-A${round}`, types: [type], limit: 15, leaseSeconds: 60 }),
      queue.claim({ owner: `${TAG}-B${round}`, types: [type], limit: 15, leaseSeconds: 60 }),
    ]);
    const idsA = new Set(a.map((j) => j.id));
    const overlap = b.filter((j) => idsA.has(j.id)).length;
    const union = new Set([...a, ...b].map((j) => j.id)).size;
    assert(
      `round ${round}: intersection = ∅`,
      overlap === 0,
      `A=${a.length} B=${b.length} ∩=${overlap} ∪=${union}`,
    );
    assert(`round ${round}: all 20 claimed exactly once`, a.length + b.length === 20 && union === 20);
    assert(
      `round ${round}: every row leased to its claimer at attempts=1`,
      a.every((j) => j.lease_owner === `${TAG}-A${round}` && j.state === "leased" && j.attempts === 1) &&
        b.every((j) => j.lease_owner === `${TAG}-B${round}` && j.state === "leased" && j.attempts === 1),
    );
  }
}

async function dodThrowRequeues(): Promise<void> {
  console.log("\n--- DoD 2: a throwing handler re-queues with backoff ---");
  const type = fixtureType("throws");
  const registry = createRegistry([
    defineJob({
      type,
      payloadSchema: z.object({}).passthrough(),
      timeoutMs: 5_000,
      handler: async () => {
        throw new Error("synthetic handler failure");
      },
    }),
  ]);
  const { job } = await queue.enqueue({ type, payload: {} });
  const summary = await runWorker({ queue, registry, budgetMs: 20_000, maxJobs: 1 });
  const row = await mustGet(job.id);
  const nowMs = Date.now();

  assert("worker reports one retry", summary.claimed === 1 && summary.retried === 1, JSON.stringify(summary));
  assert("attempts = 1", row.attempts === 1, `attempts=${row.attempts}`);
  assert("state = 'queued'", row.state === "queued", row.state);
  assert("run_after > now()", Date.parse(row.run_after) > nowMs, row.run_after);
  assert(
    "last_error populated",
    (row.last_error ?? "").includes("synthetic handler failure"),
    row.last_error ?? "null",
  );
  assert("lease cleared", row.lease_owner === null && row.lease_expires_at === null);
}

async function dodDeadLetter(): Promise<void> {
  console.log("\n--- DoD 3: dead after max_attempts ---");
  const type = fixtureType("dead");
  let calls = 0;
  const registry = createRegistry([
    defineJob({
      type,
      payloadSchema: z.object({}).passthrough(),
      timeoutMs: 5_000,
      handler: async () => {
        calls += 1;
        throw new Error(`synthetic failure #${calls}`);
      },
    }),
  ]);
  const { job } = await queue.enqueue({ type, payload: {}, maxAttempts: 3 });
  // Retries immediately runnable in one pass. run_after is computed from this
  // machine's clock but compared against the DB's now(); 5s in the past absorbs
  // any skew between the two.
  const summary = await runWorker({ queue, registry, budgetMs: 30_000, backoff: () => -5_000 });
  const row = await mustGet(job.id);

  assert("handler ran exactly max_attempts times", calls === 3, `calls=${calls}`);
  assert("state = 'dead'", row.state === "dead", row.state);
  assert("attempts = max_attempts = 3", row.attempts === 3, `attempts=${row.attempts}`);
  assert("last_error populated with the final failure", (row.last_error ?? "").includes("#3"), row.last_error ?? "null");
  assert("finished_at set", row.finished_at !== null);
  assert("summary: 2 retried, 1 dead", summary.retried === 2 && summary.dead === 1, JSON.stringify(summary));

  const permType = fixtureType("permanent");
  let permCalls = 0;
  const permRegistry = createRegistry([
    defineJob({
      type: permType,
      payloadSchema: z.object({}).passthrough(),
      timeoutMs: 5_000,
      handler: async () => {
        permCalls += 1;
        throw new PermanentJobError("synthetic permanent 4xx");
      },
    }),
  ]);
  const perm = await queue.enqueue({ type: permType, payload: {}, maxAttempts: 5 });
  await runWorker({ queue, registry: permRegistry, budgetMs: 20_000, backoff: () => 0 });
  const permRow = await mustGet(perm.job.id);
  assert(
    "PermanentJobError → dead after 1 attempt, no retry",
    permRow.state === "dead" && permRow.attempts === 1 && permCalls === 1,
    `state=${permRow.state} attempts=${permRow.attempts} calls=${permCalls}`,
  );

  const badType = fixtureType("badpayload");
  let badCalls = 0;
  const badRegistry = createRegistry([
    defineJob({
      type: badType,
      payloadSchema: z.object({ leadId: z.string().uuid() }),
      timeoutMs: 5_000,
      handler: async () => {
        badCalls += 1;
      },
    }),
  ]);
  const bad = await queue.enqueue({ type: badType, payload: { leadId: 42 } });
  await runWorker({ queue, registry: badRegistry, budgetMs: 20_000 });
  const badRow = await mustGet(bad.job.id);
  assert(
    "invalid payload → dead with invalid_payload, handler never called",
    badRow.state === "dead" && (badRow.last_error ?? "").includes("invalid_payload") && badCalls === 0,
    `state=${badRow.state} calls=${badCalls}`,
  );
}

async function dodExpiredLease(): Promise<void> {
  console.log("\n--- DoD 4: expired lease is re-claimable with the same idempotency_key ---");
  const type = fixtureType("lease");
  const idemKey = `${TAG}-idem-lease`;
  const { job } = await queue.enqueue({ type, payload: {}, idempotencyKey: idemKey });

  const [first] = await queue.claim({ owner: `${TAG}-crashed`, types: [type], leaseSeconds: 1 });
  assert("first worker claims it", first?.id === job.id && first.attempts === 1);

  const early = await queue.claim({ owner: `${TAG}-early`, types: [type], leaseSeconds: 60 });
  assert("a live lease is NOT re-claimable", early.length === 0, `claimed=${early.length}`);

  // The first worker "crashes": it never completes. Let the 1s lease expire.
  await sleep(1_600);

  const [second] = await queue.claim({ owner: `${TAG}-rescuer`, types: [type], leaseSeconds: 60 });
  assert("expired lease is re-claimed by another worker", second?.id === job.id, second?.id ?? "nothing claimed");
  assert(
    "re-claimer sees the same idempotency_key",
    second?.idempotency_key === idemKey,
    `${second?.idempotency_key}`,
  );
  assert("re-claim counts as attempt 2", second?.attempts === 2, `attempts=${second?.attempts}`);
  assert("lease now belongs to the re-claimer", second?.lease_owner === `${TAG}-rescuer`);

  const stale = await queue.complete(first!, `${TAG}-crashed`);
  const afterStale = await mustGet(job.id);
  assert(
    "the crashed worker's late complete() is fenced off",
    stale === "lease_lost" && afterStale.state === "leased" && afterStale.lease_owner === `${TAG}-rescuer`,
    `result=${stale} state=${afterStale.state}`,
  );
  const ok = await queue.complete(second!, `${TAG}-rescuer`);
  assert("the re-claimer completes it", ok === "ok" && (await mustGet(job.id)).state === "done");

  // A lease that expires on the final attempt dead-letters instead of re-claiming.
  const finalType = fixtureType("lease-final");
  const fin = await queue.enqueue({ type: finalType, payload: {}, maxAttempts: 1 });
  await queue.claim({ owner: `${TAG}-crashed-final`, types: [finalType], leaseSeconds: 1 });
  await sleep(1_600);
  const reclaimed = await queue.claim({ owner: `${TAG}-rescuer-final`, types: [finalType], leaseSeconds: 60 });
  const finRow = await mustGet(fin.job.id);
  assert(
    "expired lease at final attempt → dead, not re-claimed",
    reclaimed.length === 0 && finRow.state === "dead" && finRow.last_error === "lease_expired_after_final_attempt",
    `claimed=${reclaimed.length} state=${finRow.state} last_error=${finRow.last_error}`,
  );
}

async function extras(): Promise<void> {
  console.log("\n--- idempotent enqueue ---");
  const type = fixtureType("idem");
  const idemKey = `${TAG}-idem-enqueue`;
  const a = await queue.enqueue({ type, payload: { n: 1 }, idempotencyKey: idemKey });
  const b = await queue.enqueue({ type, payload: { n: 2 }, idempotencyKey: idemKey });
  const { count } = await db
    .from("jobs")
    .select("*", { count: "exact", head: true })
    .eq("idempotency_key", idemKey);
  assert("second enqueue is deduped", !a.deduped && b.deduped && a.job.id === b.job.id);
  assert("exactly one row for the key", count === 1, `count=${count}`);

  console.log("\n--- cancel ---");
  const cType = fixtureType("cancel");
  const q = await queue.enqueue({ type: cType, payload: {} });
  assert("queued job cancels", (await queue.cancel(q.job.id)) === true);
  assert("cancelled job is not claimable", (await queue.claim({ owner: `${TAG}-c`, types: [cType] })).length === 0);
  const l = await queue.enqueue({ type: cType, payload: {} });
  await queue.claim({ owner: `${TAG}-c2`, types: [cType], leaseSeconds: 60 });
  assert("leased (in-flight) job is NOT cancelled", (await queue.cancel(l.job.id)) === false);

  console.log("\n--- wall-clock budget ---");
  const bType = fixtureType("budget");
  const registry = createRegistry([
    defineJob({
      type: bType,
      payloadSchema: z.object({}).passthrough(),
      timeoutMs: 400,
      handler: async () => {
        await sleep(300);
      },
    }),
  ]);
  const jobs = await enqueueMany(bType, 10);
  const budgetMs = 2_500;
  const summary = await runWorker({ queue, registry, budgetMs, reserveMs: 500 });
  const rows = await Promise.all(jobs.map((j) => mustGet(j.id)));
  const done = rows.filter((r) => r.state === "done").length;
  const queued = rows.filter((r) => r.state === "queued").length;
  const leased = rows.filter((r) => r.state === "leased").length;
  assert("pass stops on budget, not by draining", summary.stoppedReason === "budget", JSON.stringify(summary));
  assert("pass returns within budget", summary.elapsedMs <= budgetMs, `elapsed=${summary.elapsedMs}ms budget=${budgetMs}ms`);
  assert("some but not all jobs ran", done > 0 && done < 10, `done=${done}`);
  assert("no job stranded in 'leased'", leased === 0 && done + queued === 10, `done=${done} queued=${queued} leased=${leased}`);

  console.log("\n--- handler timeout ---");
  const tType = fixtureType("timeout");
  let aborted = false;
  const tRegistry = createRegistry([
    defineJob({
      type: tType,
      payloadSchema: z.object({}).passthrough(),
      timeoutMs: 200,
      handler: async (_job, { signal }) => {
        await sleep(600);
        aborted = signal.aborted;
      },
    }),
  ]);
  const t = await queue.enqueue({ type: tType, payload: {} });
  await runWorker({ queue, registry: tRegistry, budgetMs: 10_000, maxJobs: 1 });
  const tRow = await mustGet(t.job.id);
  assert(
    "timeout → retry with job_timeout recorded",
    tRow.state === "queued" && (tRow.last_error ?? "").includes("job_timeout"),
    `state=${tRow.state} last_error=${tRow.last_error}`,
  );
  await sleep(500);
  assert("handler's AbortSignal fired", aborted);
}

async function main(): Promise<void> {
  console.log(`\n=== test-u2-jobs (tag=${TAG}) ===\n`);

  await pureTests();

  if (!(await migrationApplied())) {
    skip("DoD 1–4 and extras", "jobs table not found — apply 0006_jobs.sql and 0006b_claim_jobs_rpc.sql");
  } else {
    const before = {
      leads: await countRows("leads"),
      touches: await countRows("touches"),
      lead_events: await countRows("lead_events"),
      jobs: await countRows("jobs"),
    };
    console.log(`\nBEFORE  ${Object.entries(before).map(([k, v]) => `${k}=${v}`).join(" ")}`);

    try {
      await dodDisjointClaims();
      await dodThrowRequeues();
      await dodDeadLetter();
      await dodExpiredLease();
      await extras();
    } finally {
      const removed = await cleanup();
      console.log(`\nCleanup: removed ${removed} fixture job(s).`);
    }

    const after = {
      leads: await countRows("leads"),
      touches: await countRows("touches"),
      lead_events: await countRows("lead_events"),
      jobs: await countRows("jobs"),
    };
    console.log(`AFTER   ${Object.entries(after).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    for (const table of ["leads", "touches", "lead_events", "jobs"] as const) {
      assert(`${table} count unchanged`, before[table] === after[table], `${before[table]} → ${after[table]}`);
    }
  }

  // -------------------------------------------------------------------------
  const failed = results.filter((r) => !r.pass);
  if (skipped.length > 0) {
    console.log(`\n${skipped.length} check(s) SKIPPED:`);
    for (const s of skipped) {
      console.log(`  - ${s}`);
    }
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} test(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} checks passed.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("test-u2-jobs FAILED:", message);
  process.exit(1);
});
