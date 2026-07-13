import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { segmentsSettingsSchema } from "../src/lib/validation/jsonb";
import { parseOrThrow } from "../src/lib/validation";
import { createSettingsStore } from "../src/lib/settings/core";
import { createStateStore } from "../src/lib/state/core";
import { orgExcludedByKeywords } from "../src/lib/stages/source/filters";
import { PROPOSED_US_REALESTATE_APOLLO_QUERY } from "./proposed-us-realestate-query";
import type { LeadState } from "../src/types/enums";
import { canTransition } from "../src/types/enums";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const settings = createSettingsStore(db);
const state = createStateStore(db);

const apply = process.argv.includes("--apply");

type LegacyLead = {
  lead_id: string;
  lead_state: string;
  first_name: string | null;
  last_name: string | null;
  company_id: string;
  company_name: string;
  domain: string | null;
  reasons: string[];
};

async function loadV3ExcludeKeywords(): Promise<string[]> {
  try {
    const active = await settings.getActiveSetting("segments");
    const segments = parseOrThrow(segmentsSettingsSchema, active.value, "segments");
    const us = segments["us-realestate"];
    const query = us?.apollo_query as { exclude_keywords?: string[] } | undefined;
    if (query?.exclude_keywords?.length) {
      return query.exclude_keywords;
    }
  } catch {
    // fall through to proposed file
  }
  return [...PROPOSED_US_REALESTATE_APOLLO_QUERY.exclude_keywords];
}

function isLegacyCompany(
  company: { name: string; domain: string | null },
  excludeKeywords: string[],
): string[] {
  const reasons: string[] = [];
  if (!company.domain?.trim()) {
    reasons.push("no_domain");
  }
  if (
    orgExcludedByKeywords(
      { name: company.name, primary_domain: company.domain, website_url: null },
      company.domain,
      excludeKeywords,
    )
  ) {
    reasons.push("exclude_keywords");
  }
  return reasons;
}

async function main(): Promise<void> {
  const excludeKeywords = await loadV3ExcludeKeywords();

  const { data: rows, error } = await db
    .from("leads")
    .select(
      "id, state, first_name, last_name, company_id, companies!inner(id, name, domain, status)",
    )
    .not("state", "in", '("parked","suppressed")');

  if (error) {
    throw new Error(error.message);
  }

  const legacy: LegacyLead[] = [];

  for (const row of rows ?? []) {
    const company = row.companies as {
      id: string;
      name: string;
      domain: string | null;
      status: string | null;
    };
    const reasons = isLegacyCompany(company, excludeKeywords);
    if (reasons.length === 0) {
      continue;
    }
    legacy.push({
      lead_id: row.id,
      lead_state: row.state,
      first_name: row.first_name,
      last_name: row.last_name,
      company_id: company.id,
      company_name: company.name,
      domain: company.domain,
      reasons,
    });
  }

  console.log(`V3 exclude_keywords (${excludeKeywords.length}): ${excludeKeywords.join(", ")}`);
  console.log(`\nLegacy / pre-v3 junk leads: ${legacy.length}\n`);

  for (const item of legacy) {
    console.log(
      `- ${item.lead_id} | state=${item.lead_state} | ${item.first_name ?? ""} ${item.last_name ?? ""} | ${item.company_name} (${item.domain ?? "no domain"}) | reasons=${item.reasons.join(",")}`,
    );
  }

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply after approval to park these leads.");
    return;
  }

  let parked = 0;
  let skipped = 0;

  for (const item of legacy) {
    const fromState = item.lead_state as LeadState;
    if (!canTransition(fromState, "parked")) {
      console.warn(
        `SKIP ${item.lead_id}: cannot transition ${fromState} → parked (update state machine or park manually)`,
      );
      skipped += 1;
      continue;
    }

    await db
      .from("companies")
      .update({ park_reason: "pre_v3_icp", status: "parked" })
      .eq("id", item.company_id);

    await state.transition(item.lead_id, fromState, "parked", "pre_v3_icp_parked", {
      park_reason: "pre_v3_icp",
      company_name: item.company_name,
      domain: item.domain,
      reasons: item.reasons,
    });

    parked += 1;
    console.log(`PARKED ${item.lead_id} (${item.company_name})`);
  }

  console.log(`\nApply complete: ${parked} parked, ${skipped} skipped.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("park-legacy-leads FAILED:", message);
  process.exit(1);
});
