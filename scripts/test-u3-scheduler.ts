import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import { CapacityLedgerError, createCapacityLedger, type ReserveResult } from "../src/lib/scheduler/ledger";
import {
  InvalidTimeZoneError,
  jitteredSendAt,
  ledgerDate,
  nextSendWindow,
  rampQuota,
  type SendWindowsConfig,
} from "../src/lib/scheduler/windows";
import { send_windows, capacity_defaults } from "../src/lib/settings/seed-content";
import { sendWindowsSchema } from "../src/lib/validation/jsonb";
import type { DatabaseWithCapacity } from "../src/types/database-extensions";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key) as unknown as SupabaseClient<DatabaseWithCapacity>;
const ledger = createCapacityLedger(db);

// ---------------------------------------------------------------------------
// Harness (same shape as test-u2-jobs.ts)
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

async function throws(fn: () => unknown): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

// The only fixture is one send_accounts row with this identifier. Cleanup
// deletes it; the FK cascade removes its ledger and reservation rows.
const TAG = `test.u3.${Date.now()}`;
const FIXTURE_IDENTIFIER = `${TAG}@example.invalid`;

const TZ = "Europe/Vilnius";
// The seeded v1 settings value, parsed exactly as the settings store would.
const WINDOWS: SendWindowsConfig = sendWindowsSchema.parse(send_windows);
const RAMP = capacity_defaults.email_inbox;
const MIN = 60_000;

const iso = (d: Date) => d.toISOString();
const dow = (localDate: string) =>
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${localDate}T12:00:00Z`).getUTCDay()];

// ---------------------------------------------------------------------------
// Group 1 — pure: windows, jitter, ramp
// ---------------------------------------------------------------------------

type WindowCase = {
  name: string;
  now: string; // UTC instant
  tz?: string;
  cfg?: SendWindowsConfig;
  tier: "priority" | "secondary";
  start: string; // expected effective start, UTC
  end: string; // expected end, UTC
};

function pureWindowTests(): void {
  console.log("--- windows (pure, Europe/Vilnius, seeded send_windows v1) ---");

  const cases: WindowCase[] = [
    {
      name: "Sun 23:00 → next Tuesday 08:30–11:00 (DoD)",
      now: "2026-09-27T20:00:00Z", // Sun 23:00 EEST
      tier: "priority",
      start: "2026-09-29T05:30:00.000Z",
      end: "2026-09-29T08:00:00.000Z",
    },
    {
      name: "Fri 16:30 → Monday secondary 13:30–16:00 (DoD)",
      now: "2026-09-25T13:30:00Z", // Fri 16:30 EEST
      tier: "secondary",
      start: "2026-09-28T10:30:00.000Z",
      end: "2026-09-28T13:00:00.000Z",
    },
    {
      name: "Sat 10:00 → Monday secondary (weekend excluded, Tue is 70.5h out)",
      now: "2026-09-26T07:00:00Z",
      tier: "secondary",
      start: "2026-09-28T10:30:00.000Z",
      end: "2026-09-28T13:00:00.000Z",
    },
    {
      name: "Mon 09:00 → Tuesday priority, not Mon 13:30 (lookahead 48h)",
      now: "2026-09-28T06:00:00Z",
      tier: "priority",
      start: "2026-09-29T05:30:00.000Z",
      end: "2026-09-29T08:00:00.000Z",
    },
    {
      name: "Wed 09:00 inside the window → starts now",
      now: "2026-09-30T06:00:00Z",
      tier: "priority",
      start: "2026-09-30T06:00:00.000Z",
      end: "2026-09-30T08:00:00.000Z",
    },
    {
      name: "Wed 11:00 exactly → Thursday (end is exclusive)",
      now: "2026-09-30T08:00:00Z",
      tier: "priority",
      start: "2026-10-01T05:30:00.000Z",
      end: "2026-10-01T08:00:00.000Z",
    },
    {
      name: "Thu 12:00 → Friday secondary (next priority is Tue, >48h)",
      now: "2026-10-01T09:00:00Z",
      tier: "secondary",
      start: "2026-10-02T10:30:00.000Z",
      end: "2026-10-02T13:00:00.000Z",
    },
    {
      name: "DST autumn: Fri 2026-10-23 16:30 EEST → Mon 2026-10-26 13:30 EET = 11:30Z",
      now: "2026-10-23T13:30:00Z",
      tier: "secondary",
      start: "2026-10-26T11:30:00.000Z",
      end: "2026-10-26T14:00:00.000Z",
    },
    {
      name: "DST autumn: Sun 2026-10-25 23:00 EET (transition day) → Tue 08:30 EET = 06:30Z",
      now: "2026-10-25T21:00:00Z",
      tier: "priority",
      start: "2026-10-27T06:30:00.000Z",
      end: "2026-10-27T09:00:00.000Z",
    },
    {
      name: "DST spring: Fri 2027-03-26 16:30 EET → Mon 2027-03-29 13:30 EEST = 10:30Z",
      now: "2027-03-26T14:30:00Z",
      tier: "secondary",
      start: "2027-03-29T10:30:00.000Z",
      end: "2027-03-29T13:00:00.000Z",
    },
    {
      name: "America/New_York: Wed 07:00 EDT → same day 08:30 EDT = 12:30Z",
      now: "2026-09-30T11:00:00Z",
      tz: "America/New_York",
      tier: "priority",
      start: "2026-09-30T12:30:00.000Z",
      end: "2026-09-30T15:00:00.000Z",
    },
    {
      name: "weekend:false wins over a listed 'sat' (Fri 16:30 → Mon, never Sat)",
      now: "2026-10-02T13:30:00Z",
      cfg: { ...WINDOWS, priority_days: ["tue", "wed", "thu", "sat"] },
      tier: "secondary",
      start: "2026-10-05T10:30:00.000Z",
      end: "2026-10-05T13:00:00.000Z",
    },
    {
      name: "weekend:true with 'sat' listed → Saturday 08:30",
      now: "2026-10-02T13:30:00Z",
      cfg: { ...WINDOWS, priority_days: ["tue", "wed", "thu", "sat"], weekend: true },
      tier: "priority",
      start: "2026-10-03T05:30:00.000Z",
      end: "2026-10-03T08:00:00.000Z",
    },
    {
      name: "spring-forward gap: a 03:30 opening on 2027-03-28 (03:00→04:00) moves to 04:30 EEST",
      now: "2027-03-27T10:00:00Z",
      cfg: { ...WINDOWS, priority_days: ["sun"], secondary_days: [], window_local: ["03:30", "05:00"], weekend: true },
      tier: "priority",
      start: "2027-03-28T01:30:00.000Z",
      end: "2027-03-28T02:00:00.000Z",
    },
  ];

  for (const c of cases) {
    const w = nextSendWindow(new Date(c.now), c.tz ?? TZ, c.cfg ?? WINDOWS);
    const ok = w.tier === c.tier && iso(w.start) === c.start && iso(w.end) === c.end;
    assert(c.name, ok, `${w.tier} ${w.localDate} (${dow(w.localDate)}) ${iso(w.start)} → ${iso(w.end)}`);
  }
}

async function pureEdgeTests(): Promise<void> {
  console.log("--- windows edge cases (pure) ---");
  const onlySat = await throws(() =>
    nextSendWindow(new Date("2026-10-02T13:30:00Z"), TZ, { ...WINDOWS, priority_days: ["sat"], secondary_days: ["sun"] }),
  );
  assert("only weekend days with weekend:false → config error, never a weekend window", onlySat?.startsWith("SendWindowConfigError") === true, onlySat ?? "no throw");

  const badTz = await throws(() => nextSendWindow(new Date(), "Mars/Olympus_Mons", WINDOWS));
  assert("invalid IANA timezone throws InvalidTimeZoneError", badTz?.startsWith("InvalidTimeZoneError") === true, badTz ?? "no throw");
  const emptyTz = await throws(() => nextSendWindow(new Date(), "", WINDOWS));
  assert("empty timezone throws InvalidTimeZoneError", emptyTz?.startsWith("InvalidTimeZoneError") === true, emptyTz ?? "no throw");
  assert("InvalidTimeZoneError is exported as a class", typeof InvalidTimeZoneError === "function");

  const badDay = await throws(() => nextSendWindow(new Date(), TZ, { ...WINDOWS, priority_days: ["tuesday"] }));
  assert("unknown day key is a config error", badDay?.startsWith("SendWindowConfigError") === true, badDay ?? "no throw");

  const lookahead0 = nextSendWindow(new Date("2026-09-27T20:00:00Z"), TZ, { ...WINDOWS, priority_lookahead_hours: 0 });
  assert(
    "priority_lookahead_hours: 0 → plain earliest window (Sun 23:00 → Mon secondary)",
    lookahead0.tier === "secondary" && lookahead0.localDate === "2026-09-28",
    `${lookahead0.tier} ${lookahead0.localDate}`,
  );
}

function jitterTests(): void {
  console.log("--- jitter (pure, 1000 draws) ---");
  const w = nextSendWindow(new Date("2026-09-27T20:00:00Z"), TZ, WINDOWS);
  const J = WINDOWS.jitter_minutes * MIN;
  let maxAbs = 0;
  let minOff = Infinity;
  let maxOff = -Infinity;
  let allInside = true;
  let base = 0;
  for (let i = 0; i < 1000; i++) {
    const r = jitteredSendAt(w, WINDOWS.jitter_minutes);
    base = r.base.getTime();
    const off = r.sendAt.getTime() - base;
    maxAbs = Math.max(maxAbs, Math.abs(off));
    minOff = Math.min(minOff, off);
    maxOff = Math.max(maxOff, off);
    if (r.sendAt < w.start || r.sendAt >= w.end) {
      allInside = false;
    }
  }
  assert(`jitter within ±${WINDOWS.jitter_minutes} minutes over 1000 draws`, maxAbs <= J, `max |offset| = ${(maxAbs / MIN).toFixed(2)} min`);
  assert("every jittered send lies inside the window", allInside, `${iso(w.start)} → ${iso(w.end)}`);
  assert(
    "jitter uses both directions",
    minOff < -5 * MIN && maxOff > 5 * MIN,
    `range ${(minOff / MIN).toFixed(2)} .. ${(maxOff / MIN).toFixed(2)} min`,
  );
  const mid = jitteredSendAt(w, WINDOWS.jitter_minutes, () => 0.5);
  assert("rng 0.5 → sendAt = base = start + J", mid.sendAt.getTime() === mid.base.getTime() && mid.base.getTime() === w.start.getTime() + J, iso(mid.sendAt));
  const short = { start: new Date("2026-09-29T07:50:00Z"), end: new Date("2026-09-29T08:00:00Z") };
  const edges = [0, 0.999999].map((x) => jitteredSendAt(short, WINDOWS.jitter_minutes, () => x).sendAt);
  assert(
    "a 10-minute window shrinks the jitter and stays inside",
    edges.every((d) => d >= short.start && d < short.end),
    edges.map(iso).join(", "),
  );
}

function rampTests(): void {
  console.log("--- ramp curve (pure, capacity_defaults v1: 15→30, +5 every 4 days) ---");
  const start = "2026-10-01";
  const table: [string, string | null, number | null][] = [
    ["day 0", "2026-10-01", 15],
    ["day 3", "2026-10-04", 15],
    ["day 4", "2026-10-05", 20],
    ["day 8", "2026-10-09", 25],
    ["day 12", "2026-10-13", 30],
    ["day 100", "2027-01-09", 30],
  ];
  for (const [name, on, want] of table) {
    const got = rampQuota(RAMP, start, on as string);
    assert(`rampQuota ${name} = ${want}`, got === want, `got ${got}`);
  }
  assert("rampQuota before the start date = null", rampQuota(RAMP, start, "2026-09-30") === null);
  assert("rampQuota with no ramp start = null (unknown is null, not 0)", rampQuota(RAMP, null, "2026-10-01") === null);
  assert(
    "ledgerDate is the UTC date",
    ledgerDate(new Date("2026-09-29T23:30:00Z")) === "2026-09-29" && ledgerDate(new Date("2026-09-29T21:30:00-03:00")) === "2026-09-30",
  );
}

// ---------------------------------------------------------------------------
// Group 2 — DB: reserve_capacity / settle_capacity (0007, 0007b)
// ---------------------------------------------------------------------------

type CountedTable =
  | "leads"
  | "touches"
  | "lead_events"
  | "jobs"
  | "send_accounts"
  | "capacity_ledger"
  | "capacity_reservations";

async function countRows(table: CountedTable): Promise<number> {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) {
    throw new Error(`count ${table} failed: ${error.message}`);
  }
  if (count === null) {
    throw new Error(`count ${table} returned null — does the table exist?`);
  }
  return count;
}

async function migrationApplied(): Promise<boolean> {
  const { error } = await db.from("capacity_reservations").select("id").limit(1);
  if (!error) {
    return true;
  }
  if (error.code === "PGRST205" || error.message.includes("schema cache")) {
    return false;
  }
  throw new Error(`capacity_reservations probe failed: ${error.message}`);
}

async function createFixtureAccount(): Promise<string> {
  const { data, error } = await db
    .from("send_accounts")
    .insert({
      identifier: FIXTURE_IDENTIFIER,
      kind: "test",
      provider: "test",
      health: "test_fixture",
      paused_reason: "synthetic U3 test fixture",
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`fixture account insert failed: ${error?.message ?? "no row"}`);
  }
  return data.id;
}

async function cleanup(): Promise<number> {
  const { data, error } = await db.from("send_accounts").delete().eq("identifier", FIXTURE_IDENTIFIER).select("id");
  if (error) {
    throw new Error(`cleanup failed: ${error.message}`);
  }
  return data?.length ?? 0;
}

async function reservationCount(accountId: string, date: string): Promise<number> {
  const { count, error } = await db
    .from("capacity_reservations")
    .select("*", { count: "exact", head: true })
    .eq("send_account_id", accountId)
    .eq("date", date);
  if (error || count === null) {
    throw new Error(`reservation count failed: ${error?.message ?? "null"}`);
  }
  return count;
}

async function day(accountId: string, date: string) {
  const row = await ledger.getDay(accountId, date);
  if (!row) {
    throw new Error(`ledger row ${date} missing`);
  }
  return row;
}

function mustOk(r: ReserveResult, context: string): string {
  if (!r.ok) {
    throw new Error(`${context}: expected ok, got ${r.reason}`);
  }
  return r.reservation.id;
}

// Synthetic dates far from any real send day.
const D = (n: number) => `2099-01-${String(n).padStart(2, "0")}`;

async function dodConcurrentReserve(accountId: string): Promise<string[]> {
  console.log("\n--- DoD 1: 30 concurrent reserve_capacity at quota 15 → exactly 15 ok ---");
  let firstRoundIds: string[] = [];
  for (const [round, date] of [D(1), D(2), D(3)].entries()) {
    const out = await Promise.all(
      Array.from({ length: 30 }, () => ledger.reserve({ sendAccountId: accountId, date, quota: 15 })),
    );
    const ok = out.filter((r) => r.ok);
    const exhausted = out.filter((r) => !r.ok && r.reason === "quota_exhausted");
    const row = await day(accountId, date);
    const rows = await reservationCount(accountId, date);
    assert(
      `round ${round + 1}: exactly 15 ok and 15 quota_exhausted`,
      ok.length === 15 && exhausted.length === 15,
      `ok=${ok.length} quota_exhausted=${exhausted.length}`,
    );
    assert(`round ${round + 1}: capacity_ledger.reserved = 15`, row.reserved === 15 && row.quota === 15 && row.used === 0, `quota=${row.quota} used=${row.used} reserved=${row.reserved}`);
    assert(`round ${round + 1}: 15 reservation rows`, rows === 15, `rows=${rows}`);
    if (round === 0) {
      firstRoundIds = ok.map((r) => mustOk(r, "round 1"));
    }
  }
  return firstRoundIds;
}

async function dodRelease(accountId: string, ids: string[]): Promise<void> {
  console.log("\n--- DoD 2: releasing a reservation decrements ---");
  const first = await ledger.release(ids[0]);
  assert("release → ok, reserved 15 → 14", first.status === "ok" && first.state === "released" && first.reserved === 14, `status=${first.status} reserved=${first.reserved}`);
  const again = await ledger.release(ids[0]);
  assert("second release is 'already', reserved stays 14", again.status === "already" && again.reserved === 14, `status=${again.status} reserved=${again.reserved}`);
  const refill = await ledger.reserve({ sendAccountId: accountId, date: D(1), quota: 15 });
  assert("freed capacity can be reserved again", refill.ok && refill.snapshot.reserved === 15, JSON.stringify(refill.snapshot));
  const full = await ledger.reserve({ sendAccountId: accountId, date: D(1), quota: 15 });
  assert("…and then the day is full again", !full.ok, full.ok ? "ok" : full.reason);
  const row = await ledger.getReservation(ids[0]);
  assert("released reservation has settled_at", row?.state === "released" && row.settled_at !== null, `${row?.state} ${row?.settled_at}`);
}

async function settlePaths(accountId: string): Promise<void> {
  console.log("\n--- settle paths: accept / fail / uncertain / reconcile ---");
  const date = D(4);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(mustOk(await ledger.reserve({ sendAccountId: accountId, date, quota: 10 }), `settle fixture ${i}`));
  }
  const [r1, r2, r3, r4, r5] = ids;

  const a = await ledger.accept(r1);
  assert("accept: reserved −1, used +1, accepted +1", a.reserved === 4 && a.used === 1 && a.accepted === 1, JSON.stringify(a));
  const f = await ledger.fail(r2);
  assert("fail: reserved −1, failed +1, used unchanged", f.reserved === 3 && f.failed === 1 && f.used === 1, JSON.stringify(f));
  const u = await ledger.markUncertain(r3);
  assert("uncertain: counters unchanged — capacity stays held", u.state === "uncertain" && u.reserved === 3 && u.used === 1, JSON.stringify(u));
  const uRow = await ledger.getReservation(r3);
  assert("uncertain reservation is not settled", uRow?.settled_at === null, `settled_at=${uRow?.settled_at}`);
  const rs = await ledger.reconcile(r3, "sent");
  assert("reconcile sent: reserved −1, used +1, reconciled +1", rs.reserved === 2 && rs.used === 2 && rs.reconciled === 1 && rs.accepted === 1, JSON.stringify(rs));
  await ledger.markUncertain(r4);
  const rn = await ledger.reconcile(r4, "not_sent");
  assert("reconcile not_sent: reserved −1, reconciled +1, used unchanged", rn.reserved === 1 && rn.used === 2 && rn.reconciled === 2, JSON.stringify(rn));
  const r3Row = await ledger.getReservation(r3);
  assert("reconciled row records its outcome", r3Row?.state === "reconciled" && r3Row.reconciled_outcome === "sent", `${r3Row?.state}/${r3Row?.reconciled_outcome}`);

  console.log("--- invalid transitions ---");
  const acceptAgain = await ledger.accept(r1);
  assert("accepting an accepted reservation is 'already', no double count", acceptAgain.status === "already" && acceptAgain.used === 2 && acceptAgain.accepted === 1, JSON.stringify(acceptAgain));
  const releaseAccepted = await throws(() => ledger.release(r1));
  assert("releasing an accepted reservation raises", releaseAccepted?.includes("cannot release") === true, releaseAccepted ?? "no throw");
  const reconcileReserved = await throws(() => ledger.reconcile(r5, "sent"));
  assert("reconciling a reservation that was never uncertain raises", reconcileReserved?.includes("cannot reconcile_sent") === true, reconcileReserved ?? "no throw");
  const flipOutcome = await throws(() => ledger.reconcile(r4, "sent"));
  assert("re-reconciling not_sent as sent raises", flipOutcome?.includes("in state reconciled") === true, flipOutcome ?? "no throw");
  const unknownOutcome = await db.rpc("settle_capacity", { p_reservation_id: r5, p_outcome: "resend" });
  assert("unknown outcome raises", unknownOutcome.error?.message.includes("unknown outcome") === true, unknownOutcome.error?.message ?? "no error");

  const final = await day(accountId, date);
  assert(
    "ledger after all paths: quota 10, used 2, reserved 1, accepted 1, failed 1, reconciled 2",
    final.quota === 10 && final.used === 2 && final.reserved === 1 && final.accepted === 1 && final.failed === 1 && final.reconciled === 2,
    JSON.stringify({ q: final.quota, u: final.used, r: final.reserved, a: final.accepted, f: final.failed, rc: final.reconciled }),
  );
}

async function idempotency(accountId: string): Promise<void> {
  console.log("\n--- idempotency keys ---");
  const date = D(5);
  const k1 = `${TAG}.idem.1`;
  const first = await ledger.reserve({ sendAccountId: accountId, date, quota: 15, idempotencyKey: k1 });
  const second = await ledger.reserve({ sendAccountId: accountId, date, quota: 15, idempotencyKey: k1 });
  const id1 = mustOk(first, "idem first");
  assert(
    "same key twice → same reservation, replayed, one increment",
    second.ok && second.reservation.id === id1 && second.replayed && first.ok && !first.replayed && second.snapshot.reserved === 1,
    JSON.stringify(second.snapshot),
  );

  const k2 = `${TAG}.idem.2`;
  const burst = await Promise.all(
    Array.from({ length: 10 }, () => ledger.reserve({ sendAccountId: accountId, date, quota: 15, idempotencyKey: k2 })),
  );
  const ids = new Set(burst.map((r) => mustOk(r, "idem burst")));
  const fresh = burst.filter((r) => r.ok && !r.replayed).length;
  const row = await day(accountId, date);
  assert("10 concurrent calls, one key → one reservation", ids.size === 1 && fresh === 1, `distinct=${ids.size} fresh=${fresh}`);
  assert("…and exactly one increment", row.reserved === 2, `reserved=${row.reserved}`);

  await ledger.release(id1);
  const replayReleased = await ledger.reserve({ sendAccountId: accountId, date, quota: 15, idempotencyKey: k1 });
  assert(
    "replaying a released key returns it as released (no new capacity taken)",
    replayReleased.ok && replayReleased.reservation.state === "released" && replayReleased.snapshot.reserved === 1,
    replayReleased.ok ? `${replayReleased.reservation.state} reserved=${replayReleased.snapshot.reserved}` : replayReleased.reason,
  );
}

async function quotaAndArgs(accountId: string): Promise<void> {
  console.log("\n--- quota monotonicity and argument checks ---");
  const date = D(6);
  await ledger.reserve({ sendAccountId: accountId, date, quota: 15 });
  const lower = await ledger.reserve({ sendAccountId: accountId, date, quota: 10 });
  assert("a lower quota lowers the day", lower.snapshot.quota === 10, `quota=${lower.snapshot.quota}`);
  const higher = await ledger.reserve({ sendAccountId: accountId, date, quota: 20 });
  assert("a higher quota does not raise it", higher.snapshot.quota === 10, `quota=${higher.snapshot.quota}`);

  const zero = await ledger.reserve({ sendAccountId: accountId, date: D(7), quota: 0 });
  assert("quota 0 → quota_exhausted", !zero.ok && zero.snapshot.reserved === 0, zero.ok ? "ok" : zero.reason);

  const multi = await ledger.reserve({ sendAccountId: accountId, date: D(8), quota: 5, n: 3 });
  const over = await ledger.reserve({ sendAccountId: accountId, date: D(8), quota: 5, n: 3 });
  assert("n=3 reserves 3; a second n=3 against quota 5 is refused whole", multi.ok && multi.snapshot.reserved === 3 && !over.ok && over.snapshot.reserved === 3, `${multi.snapshot.reserved}/${over.snapshot.reserved}`);

  const nZero = await throws(() => ledger.reserve({ sendAccountId: accountId, date: D(8), quota: 5, n: 0 }));
  assert("n=0 is rejected", nZero?.startsWith("CapacityLedgerError") === true && nZero.includes("p_n must be"), nZero ?? "no throw");
  const negQuota = await throws(() => ledger.reserve({ sendAccountId: accountId, date: D(8), quota: -1 }));
  assert("negative quota is rejected", negQuota?.includes("p_quota must be") === true, negQuota ?? "no throw");
  const unknownAccount = await throws(() =>
    ledger.reserve({ sendAccountId: "00000000-0000-4000-8000-000000000000", date: D(8), quota: 5 }),
  );
  assert("unknown send account is rejected (FK)", unknownAccount !== null && unknownAccount.includes("foreign key"), unknownAccount ?? "no throw");
  assert("CapacityLedgerError is the error class", typeof CapacityLedgerError === "function");
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== test-u3-scheduler (tag=${TAG}) ===\n`);

  pureWindowTests();
  await pureEdgeTests();
  jitterTests();
  rampTests();

  if (!(await migrationApplied())) {
    skip("DoD 1–2 and ledger checks", "capacity_reservations not found — apply 0007_capacity_counters.sql and 0007b_reserve_capacity.sql");
  } else {
    const tables: CountedTable[] = ["leads", "touches", "lead_events", "jobs", "send_accounts", "capacity_ledger", "capacity_reservations"];
    const before: Record<string, number> = {};
    for (const t of tables) {
      before[t] = await countRows(t);
    }
    console.log(`\nBEFORE  ${tables.map((t) => `${t}=${before[t]}`).join(" ")}`);

    try {
      const accountId = await createFixtureAccount();
      const ids = await dodConcurrentReserve(accountId);
      await dodRelease(accountId, ids);
      await settlePaths(accountId);
      await idempotency(accountId);
      await quotaAndArgs(accountId);
    } finally {
      const removed = await cleanup();
      console.log(`\nCleanup: removed ${removed} fixture send account(s) (ledger and reservations cascade).`);
    }

    const after: Record<string, number> = {};
    for (const t of tables) {
      after[t] = await countRows(t);
    }
    console.log(`AFTER   ${tables.map((t) => `${t}=${after[t]}`).join(" ")}`);
    for (const t of tables) {
      assert(`${t} count unchanged`, before[t] === after[t], `${before[t]} → ${after[t]}`);
    }
  }

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
  console.error("test-u3-scheduler FAILED:", message);
  process.exit(1);
});
