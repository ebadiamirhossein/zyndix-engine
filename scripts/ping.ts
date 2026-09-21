/**
 * scripts/ping.ts — step 1 DoD: prove the Supabase round-trip.
 *
 * Read-only by design. Migration `0001_init_schema.sql` ends with
 * `drop table if exists _ping;`, so the throwaway table the original DoD
 * wrote to does not exist in the live database. Rather than re-adding a
 * permanent scratch table, this proves the same three things by reading:
 *
 *   1. URL + service-role key + connectivity  -> `settings` is readable
 *   2. migration 0001 applied                 -> `leads` is readable
 *   3. migration 0002 applied                 -> `transition_lead` RPC exists
 *
 * It writes nothing and prints no secret values.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  console.log("\n=== ping (read-only Supabase round-trip) ===\n");
  console.log(`host: ${new URL(url!).host}\n`);

  const startedAt = Date.now();

  // 1. connectivity + credentials
  const { count: settingsCount, error: settingsError } = await db
    .from("settings")
    .select("id", { count: "exact", head: true });

  assert(
    "settings readable (URL + service-role key valid)",
    !settingsError && (settingsCount ?? 0) > 0,
    settingsError ? settingsError.message : `${settingsCount} row(s)`,
  );

  // 2. migration 0001 applied
  const { count: leadsCount, error: leadsError } = await db
    .from("leads")
    .select("id", { count: "exact", head: true });

  assert(
    "leads readable (migration 0001 applied)",
    !leadsError,
    leadsError ? leadsError.message : `${leadsCount} row(s)`,
  );

  // 3. migration 0002 applied.
  // A nil uuid makes the function raise `lead % not found` (Postgres code
  // P0001). If the function were missing, PostgREST would answer PGRST202 —
  // whose message also contains "not found", so the code is what separates
  // the two, not the text.
  const { error: rpcError } = await db.rpc(
    "transition_lead" as never,
    {
      p_lead_id: NIL_UUID,
      p_from: "sourced",
      p_to: "enriching",
      p_event: "ping",
      p_detail: {},
      p_next_action: null,
    } as never,
  );

  const rpcCode = (rpcError as { code?: string } | null)?.code;
  assert(
    "transition_lead RPC exists (migration 0002 applied)",
    rpcCode === "P0001" && (rpcError?.message ?? "").includes("not found"),
    rpcCode === "PGRST202"
      ? "PGRST202 — function missing, migration 0002 NOT applied"
      : `${rpcCode ?? "no error"}: ${rpcError?.message ?? "RPC unexpectedly succeeded"}`,
  );

  const elapsedMs = Date.now() - startedAt;
  console.log(`\nround-trip: ${elapsedMs}ms`);

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }

  console.log(`All ${results.length} checks passed.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("ping FAILED:", message);
  process.exit(1);
});
