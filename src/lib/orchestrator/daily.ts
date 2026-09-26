import { ledgerDate, rampQuota, type EmailInboxRamp } from "@/lib/scheduler/windows";
import { checkBounceRate, type BounceRateDeps } from "@/lib/sending/bounce-rate";
import { capacityDefaultsSchema } from "@/lib/validation/jsonb";

// /api/cron/daily (09 §U9). Once a day, per email send account:
//   1. ramp_stage from the capacity_defaults ramp (rampQuota);
//   2. bounce_rate_7d recomputed for accounts that are not paused, through
//      checkBounceRate — the same function the bounce webhook calls, so the
//      auto-pause threshold and its stop path are shared.
// Idempotent: a second run on the same day writes the same values and
// changes no ramp_stage.
//
// Ledger "roll": nothing to do. capacity_ledger rows are per (account, UTC
// date) and created lazily by reserve_capacity()/record_provider_send
// (0007b, 0009d) with that day's quota, and no function in the migrations
// expires reservations. A `reserved` reservation left on a past date (a
// crash between reserve and dispatch) only holds capacity on its own day,
// so it is counted and reported here, never mutated.

export type RampStage = "warmup" | "ramp1" | "ramp2" | "full";

/**
 * docs/02 lists warmup / ramp1 / ramp2 / full; the ramp curve has more steps
 * than that (seed: 15 → 20 → 25 → 30), so the mapping is by position, not by
 * step:
 *   warmup — the ramp has not started (ramp_started_on null: no cold sends yet);
 *   ramp1  — at start_quota (the first ramp_every_days days);
 *   ramp2  — above start_quota, below max_quota;
 *   full   — at max_quota.
 */
export function rampStage(ramp: EmailInboxRamp, rampStartedOn: string | null, onDate: string): RampStage {
  const quota = rampQuota(ramp, rampStartedOn, onDate);
  if (quota === null) return "warmup";
  if (quota >= ramp.max_quota) return "full";
  if (quota <= ramp.start_quota) return "ramp1";
  return "ramp2";
}

export type DailyDeps = BounceRateDeps & { now?: () => Date };

export type DailyAccountResult = {
  send_account_id: string;
  ramp_stage: RampStage;
  ramp_changed: boolean;
  /** Null: paused (not recomputed) or no sends in 7 days (left as stored). */
  bounce_rate_7d: number | null;
  bounce_checked: boolean;
  auto_paused: boolean;
  error?: string;
};

export type DailySummary = {
  date: string;
  accounts: number;
  ramp_changed: number;
  bounce_checked: number;
  auto_paused: number;
  /** `reserved` reservations on dates before today (see the header). */
  stale_reserved: number;
  failed: number;
  results: DailyAccountResult[];
};

export async function runDaily(deps: DailyDeps, options: { accountIds?: string[] } = {}): Promise<DailySummary> {
  const now = (deps.now ?? (() => new Date()))();
  const today = ledgerDate(now);
  const ramp = capacityDefaultsSchema.parse((await deps.getActiveSetting("capacity_defaults")).value).email_inbox;

  let query = deps.db
    .from("send_accounts")
    .select("id, health, ramp_stage, ramp_started_on")
    .eq("kind", "email")
    .order("id");
  if (options.accountIds) query = query.in("id", options.accountIds);
  const { data: accounts, error } = await query;
  if (error) throw new Error(`daily: list send_accounts: ${error.message}`);

  const results: DailyAccountResult[] = [];
  for (const account of accounts ?? []) {
    const stage = rampStage(ramp, account.ramp_started_on, today);
    const result: DailyAccountResult = {
      send_account_id: account.id,
      ramp_stage: stage,
      ramp_changed: false,
      bounce_rate_7d: null,
      bounce_checked: false,
      auto_paused: false,
    };
    try {
      if (account.ramp_stage !== stage) {
        const { error: updateError } = await deps.db.from("send_accounts").update({ ramp_stage: stage }).eq("id", account.id);
        if (updateError) throw new Error(`ramp_stage: ${updateError.message}`);
        result.ramp_changed = true;
      }
      // A paused account is not recomputed: its rate cannot un-pause it (only
      // the operator does), and a re-trip would re-run the pause path.
      if (account.health === "ok") {
        const bounce = await checkBounceRate(deps, null, account.id, now);
        result.bounce_checked = true;
        result.bounce_rate_7d = bounce.rate;
        result.auto_paused = bounce.paused;
      }
    } catch (accountError) {
      result.error = accountError instanceof Error ? accountError.message : String(accountError);
      console.error(`[daily] send_account ${account.id}: ${result.error}`);
    }
    results.push(result);
  }

  let staleQuery = deps.db
    .from("capacity_reservations")
    .select("id", { count: "exact", head: true })
    .eq("state", "reserved")
    .lt("date", today);
  if (options.accountIds) staleQuery = staleQuery.in("send_account_id", options.accountIds);
  const { count: staleReserved, error: staleError } = await staleQuery;
  if (staleError) throw new Error(`daily: stale reservations: ${staleError.message}`);

  return {
    date: today,
    accounts: results.length,
    ramp_changed: results.filter((r) => r.ramp_changed).length,
    bounce_checked: results.filter((r) => r.bounce_checked).length,
    auto_paused: results.filter((r) => r.auto_paused).length,
    stale_reserved: staleReserved ?? 0,
    failed: results.filter((r) => r.error).length,
    results,
  };
}
