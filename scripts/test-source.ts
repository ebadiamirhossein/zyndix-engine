import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ApolloApiError,
  ApolloPlanError,
  createApolloClient,
  getRevealCallCount,
  resetRevealCallCount,
} from "../src/lib/integrations/apollo";
import { createSettingsStore } from "../src/lib/settings/core";
import { writeSourcePage } from "../src/lib/stages/source/cursor";
import { runSourceStage } from "../src/lib/stages/source/core";
import type { DatabaseWithSourceCursors } from "../src/types/database-extensions";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key) as SupabaseClient<DatabaseWithSourceCursors>;
const settings = createSettingsStore(db);
const apollo = createApolloClient();

function parseLimit(argv: string[]): number {
  const idx = argv.indexOf("--limit");
  if (idx === -1) {
    return 5;
  }
  const value = Number.parseInt(argv[idx + 1] ?? "5", 10);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function findDuplicateApolloPersonIds(): Promise<string[]> {
  const { data, error } = await db
    .from("leads")
    .select("apollo_person_id")
    .not("apollo_person_id", "is", null);

  if (error) {
    throw new Error(`duplicate check failed on leads.apollo_person_id: ${error.message}`);
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const value = row.apollo_person_id;
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c > 1).map(([v]) => v);
}

async function findDuplicateCompanyDomains(): Promise<string[]> {
  const { data, error } = await db
    .from("companies")
    .select("domain")
    .not("domain", "is", null);

  if (error) {
    throw new Error(`duplicate check failed on companies.domain: ${error.message}`);
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const value = row.domain;
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c > 1).map(([v]) => v);
}

async function findDuplicateApolloOrgIds(): Promise<string[]> {
  const { data, error } = await db
    .from("companies")
    .select("apollo_org_id")
    .not("apollo_org_id", "is", null);

  if (error) {
    throw new Error(`duplicate check failed on companies.apollo_org_id: ${error.message}`);
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const value = row.apollo_org_id;
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c > 1).map(([v]) => v);
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv);
  resetRevealCallCount();

  await writeSourcePage(db, "us-realestate", 1);
  console.log("Reset source_cursors page to 1 for us-realestate");

  const run = () =>
    runSourceStage(
      {
        db,
        apollo,
        getActiveSetting: settings.getActiveSetting,
      },
      { limit },
    );

  const summary1 = await run();
  console.log("\n=== Source run 1 summary ===");
  console.log(JSON.stringify(summary1, null, 2));

  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: createdLeads, error: leadsError } = await db
    .from("leads")
    .select(
      "id, first_name, last_name, title, email, email_status, state, companies(name, domain)",
    )
    .eq("state", "sourced")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (leadsError) {
    throw new Error(leadsError.message);
  }

  console.log("\n=== Created leads (run 1) ===");
  for (const lead of createdLeads ?? []) {
    const company = lead.companies as { name: string; domain: string | null } | null;
    const masked = !lead.email;
    console.log(
      `- ${lead.first_name ?? ""} ${lead.last_name ?? ""} | ${lead.title ?? ""} | ${company?.name ?? ""} (${company?.domain ?? "no domain"}) | email_status=${lead.email_status} | email=${lead.email ?? "null (masked/search-only)"} | masked=${masked}`,
    );
  }

  assert(
    "run 1 sourced from Apollo (created leads, deduped existing, or pipeline full)",
    summary1.pipeline_full === true ||
      summary1.leads_created >= 1 ||
      (summary1.orgs_found >= 1 && summary1.skipped_duplicate >= 1),
    `orgs=${summary1.orgs_found} companies=${summary1.companies_created} leads=${summary1.leads_created} skipped_dup=${summary1.skipped_duplicate}`,
  );

  if (summary1.leads_created > 0) {
    assert(
      "all new leads are state sourced",
      (createdLeads ?? []).every((l) => l.state === "sourced"),
    );

    for (const lead of createdLeads ?? []) {
      const { count } = await db
        .from("lead_events")
        .select("id", { count: "exact", head: true })
        .eq("lead_id", lead.id)
        .eq("event", "sourced");

      assert(
        `lead ${lead.id} has sourced lead_event`,
        (count ?? 0) === 1,
        `count=${count}`,
      );
    }
  }

  const summary2 = await run();
  console.log("\n=== Source run 2 summary (dedupe + page 2) ===");
  console.log(JSON.stringify(summary2, null, 2));

  assert(
    "run 1 used apollo page 1",
    summary1.apollo_page === 1,
    `apollo_page=${summary1.apollo_page}`,
  );
  assert(
    "run 2 advanced to apollo page 2",
    summary2.apollo_page === 2,
    `apollo_page=${summary2.apollo_page}`,
  );

  const overlap = summary1.apollo_org_names.filter((name) =>
    summary2.apollo_org_names.includes(name),
  );
  assert(
    "page 1 and page 2 returned different orgs",
    summary1.apollo_org_names.length > 0 &&
      summary2.apollo_org_names.length > 0 &&
      overlap.length === 0,
    `page1=${summary1.apollo_org_names.slice(0, 3).join(", ")} | page2=${summary2.apollo_org_names.slice(0, 3).join(", ")} | overlap=${overlap.length}`,
  );

  await writeSourcePage(db, "us-realestate", 1);
  console.log("\nReset source_cursors page to 1 for dedupe re-fetch test");

  const summary3 = await run();
  console.log("\n=== Source run 3 summary (page 1 re-fetch / dedupe) ===");
  console.log(JSON.stringify(summary3, null, 2));

  assert(
    "run 3 re-fetched page 1",
    summary3.apollo_page === 1,
    `apollo_page=${summary3.apollo_page}`,
  );
  assert(
    "run 3 skipped_duplicate >= 1 (page 1 orgs already in DB)",
    summary3.skipped_duplicate >= 1,
    `skipped_duplicate=${summary3.skipped_duplicate}`,
  );

  const dupPersonIds = await findDuplicateApolloPersonIds();
  assert(
    "zero duplicate apollo_person_id in leads",
    dupPersonIds.length === 0,
    dupPersonIds.join(", ") || "none",
  );

  const dupDomains = await findDuplicateCompanyDomains();
  assert(
    "zero duplicate domain in companies",
    dupDomains.length === 0,
    dupDomains.join(", ") || "none",
  );

  const dupOrgIds = await findDuplicateApolloOrgIds();
  assert(
    "zero duplicate apollo_org_id in companies",
    dupOrgIds.length === 0,
    dupOrgIds.join(", ") || "none",
  );

  assert(
    "revealPersonEmail was never called",
    getRevealCallCount() === 0,
    `reveal_calls=${getRevealCallCount()}`,
  );

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} assertion(s) failed.`);
    process.exit(1);
  }

  console.log(`\nAll ${results.length} checks passed.`);
}

main().catch((error: unknown) => {
  if (error instanceof ApolloPlanError || error instanceof ApolloApiError) {
    console.error("test-source FAILED (Apollo):", error.message);
    console.error("status:", error.status);
    console.error("body:", error.body);
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("test-source FAILED:", message);
  process.exit(1);
});
