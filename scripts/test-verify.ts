import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createMillionVerifierClient } from "../src/lib/integrations/millionverifier";
import { createStateStore } from "../src/lib/state/core";
import { runVerifyStage } from "../src/lib/stages/verify/core";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

if (!process.env.APOLLO_API_KEY) {
  console.error("Missing APOLLO_API_KEY in .env.local");
  process.exit(1);
}

if (!process.env.MILLIONVERIFIER_API_KEY) {
  console.error("Missing MILLIONVERIFIER_API_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const state = createStateStore(db);
const millionverifier = createMillionVerifierClient();

function parseLimit(argv: string[]): number {
  const idx = argv.indexOf("--limit");
  if (idx === -1) return 3;
  const value = Number.parseInt(argv[idx + 1] ?? "3", 10);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));
  console.log(`\n=== test-verify (limit=${limit}) ===\n`);

  // Known-bad control (integration only)
  // Use reserved `.invalid` TLD so domain cannot exist.
  const fake = "definitely-not-real-xyz123@zyndix-invalid-test.invalid";
  const control = await millionverifier.verifyEmail(fake);
  console.log("\n--- Known-bad control ---");
  console.log(JSON.stringify(control, null, 2));
  assert("known-bad control maps to invalid", control.email_status === "invalid");

  // Snapshot lead ids before
  const { data: before } = await db
    .from("leads")
    .select("id, first_name, last_name, email, state, apollo_person_id, companies(name, domain)")
    .eq("state", "qualified")
    .order("created_at", { ascending: true })
    .limit(limit);

  const pickedIds = (before ?? []).map((row) => row.id);
  console.log(`\nPicking up to ${limit} qualified lead(s): ${pickedIds.join(", ") || "(none)"}`);
  if (pickedIds.length === 0) {
    console.error("No qualified leads available to verify.");
    process.exit(1);
  }

  console.log("\n--- Before reveal ---");
  for (const row of before ?? []) {
    const company = row.companies as { name: string; domain: string | null } | null;
    console.log(
      `- ${row.id} | ${row.first_name ?? ""} ${row.last_name ?? ""} | ${company?.name ?? ""} (${company?.domain ?? ""}) | email=${row.email ?? "null"}`,
    );
  }

  const summary = await runVerifyStage(
    { db, millionverifier, transition: state.transition },
    { limit },
  );

  console.log("\n=== Verify summary ===");
  console.log(JSON.stringify(summary, null, 2));

  console.log("\n--- After reveal+verify ---");
  for (const leadId of pickedIds) {
    const { data: lead } = await db
      .from("leads")
      .select("id, state, first_name, last_name, email, email_status, email_verified_at")
      .eq("id", leadId)
      .maybeSingle();

    console.log(JSON.stringify(lead, null, 2));
  }

  for (const leadId of pickedIds) {
    const lead = await state.getLead(leadId);
    assert(
      `lead ${leadId} left qualified`,
      lead.state !== "qualified",
      `state=${lead.state}`,
    );

    if (lead.state === "drafting") {
      assert(`drafting lead ${leadId} has email`, Boolean(lead.email));
      assert(
        `drafting lead ${leadId} has email_verified_at`,
        Boolean(lead.email_verified_at),
      );
      assert(
        `drafting lead ${leadId} is not invalid`,
        lead.email_status !== "invalid",
        `email_status=${lead.email_status}`,
      );
    }

    const { count: revealEvents } = await db
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId)
      .eq("event", "reveal_completed");
    assert(`lead ${leadId} has reveal_completed event`, (revealEvents ?? 0) >= 1);

    const { count: verifyEvents } = await db
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId)
      .eq("event", "verify_completed");
    assert(`lead ${leadId} has verify_completed event`, (verifyEvents ?? 0) >= 1);
  }

  assert(
    "reveal count <= APOLLO_MAX_REVEALS_PER_RUN",
    summary.apollo_credits_spent <= (Number(process.env.APOLLO_MAX_REVEALS_PER_RUN ?? "5") || 5),
    `spent=${summary.apollo_credits_spent}`,
  );

  // If any invalid, ensure it was added to suppression_list
  const { data: invalidLeads } = await db
    .from("leads")
    .select("email")
    .in("id", pickedIds)
    .eq("email_status", "invalid");

  for (const row of invalidLeads ?? []) {
    if (!row.email) continue;
    const { data: suppressed } = await db
      .from("suppression_list")
      .select("id")
      .eq("email", row.email)
      .limit(1)
      .maybeSingle();
    assert(`invalid email ${row.email} added to suppression_list`, Boolean(suppressed));
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} test(s) failed.`);
    process.exit(1);
  }

  console.log(`\nAll ${results.length} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

