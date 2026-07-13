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

async function main(): Promise<void> {
  const { data: companies, error: companyError } = await db
    .from("companies")
    .select("id, name, domain")
    .or("domain.ilike.%.example.com,name.eq.State Test Co");

  if (companyError) {
    throw new Error(`Failed to find test companies: ${companyError.message}`);
  }

  const companyIds = new Set((companies ?? []).map((row) => row.id));

  const { data: namedLeads, error: leadNameError } = await db
    .from("leads")
    .select("id, first_name, last_name, company_id, companies(name, domain)")
    .eq("first_name", "Test")
    .eq("last_name", "Lead");

  if (leadNameError) {
    throw new Error(`Failed to find Test Lead rows: ${leadNameError.message}`);
  }

  for (const lead of namedLeads ?? []) {
    if (lead.company_id) {
      companyIds.add(lead.company_id);
    }
  }

  const uniqueCompanyIds = [...companyIds];
  if (uniqueCompanyIds.length === 0) {
    console.log("No test companies found (*.example.com, State Test Co, or Test Lead).");
    return;
  }

  const { data: leads, error: leadsError } = await db
    .from("leads")
    .select("id, first_name, last_name, state, company_id, companies(name, domain)")
    .in("company_id", uniqueCompanyIds);

  if (leadsError) {
    throw new Error(`Failed to find leads for test companies: ${leadsError.message}`);
  }

  const leadIds = (leads ?? []).map((row) => row.id);

  console.log("=== Purging test data ===\n");

  for (const company of companies ?? []) {
    console.log(`company: ${company.name} (${company.domain ?? "no domain"}) [${company.id}]`);
  }

  for (const lead of leads ?? []) {
    const company = lead.companies as { name: string; domain: string | null } | null;
    console.log(
      `  lead: ${lead.first_name} ${lead.last_name} | ${company?.name ?? "?"} | state=${lead.state} [${lead.id}]`,
    );
  }

  if (leadIds.length === 0) {
    console.log("\nNo leads to purge; deleting companies only.");
  }

  const tables = [
    "lead_events",
    "qualification_history",
    "qualification",
    "enrichment_payloads",
  ] as const;

  for (const table of tables) {
    if (leadIds.length === 0) {
      continue;
    }
    const { count, error } = await db
      .from(table)
      .delete({ count: "exact" })
      .in("lead_id", leadIds);

    if (error) {
      throw new Error(`Failed to delete from ${table}: ${error.message}`);
    }
    console.log(`deleted ${count ?? 0} row(s) from ${table}`);
  }

  if (leadIds.length > 0) {
    const { count: leadsDeleted, error: deleteLeadsError } = await db
      .from("leads")
      .delete({ count: "exact" })
      .in("id", leadIds);

    if (deleteLeadsError) {
      throw new Error(`Failed to delete leads: ${deleteLeadsError.message}`);
    }
    console.log(`deleted ${leadsDeleted ?? 0} row(s) from leads`);
  }

  const { count: companiesDeleted, error: deleteCompaniesError } = await db
    .from("companies")
    .delete({ count: "exact" })
    .in("id", uniqueCompanyIds);

  if (deleteCompaniesError) {
    throw new Error(`Failed to delete companies: ${deleteCompaniesError.message}`);
  }
  console.log(`deleted ${companiesDeleted ?? 0} row(s) from companies`);

  console.log("\nPurge complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
