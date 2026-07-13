import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createStateStore } from "../src/lib/state/core";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const state = createStateStore(db);

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function looksLikeToolingFailure(reason: string | null): boolean {
  if (!reason) {
    return false;
  }
  const r = reason.toLowerCase();
  const patterns = [
    "no evidence",
    "insufficient evidence",
    "website scrape failed",
    "no_site_pages_returned",
    "crawl",
    "crawlable",
    "park until website becomes crawlable",
    "429",
    "rate-limited",
    "rate limited",
    "timeout",
  ];
  return patterns.some((p) => r.includes(p));
}

function looksLikeRealDisqualify(reason: string | null): boolean {
  if (!reason) {
    return false;
  }
  const r = reason.toLowerCase();
  const hard = [
    // business model / segment mismatches
    "e-commerce",
    "ecommerce",
    "shopify",
    "woocommerce",
    "storefront",
    "marketplace",
    "pure e-commerce",
    // excluded industries / competitors
    "recruit",
    "staffing",
    "headhunt",
    "private equity",
    "investment firm",
    "institutional",
    "commercial",
    "industrial",
    "cre ",
    "cre/",
    "brokerage or team",
    "not a residential",
    "not residential",
    "out-of-icp",
    "out of icp",
    "wrong industry",
    // disqualifying size / org type
    "enterprise",
    "franchise",
    "government",
    "ngo",
    "education",
    "competitor",
    "software",
    "agency",
    // buyer/title mismatch
    "not an owner",
    "not owner",
    "not a decision-maker",
    "not decision-maker",
    "not a decision maker",
    "no budget authority",
    "budget authority",
  ];
  return hard.some((p) => r.includes(p));
}

async function main(): Promise<void> {
  const apply = hasFlag(process.argv.slice(2), "--apply");

  const { data: rows, error } = await db
    .from("leads")
    .select(
      "id, state, first_name, last_name, next_action_at, company_id, companies(name, domain), qualification(disqualify_reason, fit_score, segment, model, prompt_version)",
    )
    .eq("state", "parked")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to list parked leads: ${error.message}`);
  }

  const candidates =
    (rows ?? []).filter((row) => {
      const qRow = Array.isArray(row.qualification)
        ? row.qualification[0]
        : row.qualification;
      const q = (qRow ?? null) as { disqualify_reason: string | null } | null;
      const reason = q?.disqualify_reason ?? null;
      return looksLikeToolingFailure(reason) && !looksLikeRealDisqualify(reason);
    }) ?? [];

  console.log(`Found ${candidates.length} unpark candidate(s).`);
  console.log("");

  for (const row of candidates) {
    const company = row.companies as { name: string; domain: string | null } | null;
    const qRow = Array.isArray(row.qualification)
      ? row.qualification[0]
      : row.qualification;
    const q = (qRow ?? null) as
      | {
          disqualify_reason: string | null;
          fit_score: number | null;
          segment: string | null;
          model: string | null;
          prompt_version: number | null;
        }
      | null;

    console.log(
      `- ${row.first_name ?? ""} ${row.last_name ?? ""} | ${company?.name ?? "?"} (${company?.domain ?? "no domain"}) | lead=${row.id}`,
    );
    console.log(`  disqualify_reason: ${q?.disqualify_reason ?? "null"}`);
    console.log(
      `  fit_score=${q?.fit_score ?? "null"} segment=${q?.segment ?? "null"} model=${q?.model ?? "null"} prompt_v=${q?.prompt_version ?? "null"}`,
    );
  }

  if (!apply) {
    console.log("\n(dry-run) Add --apply to transition these back to enriching.");
    return;
  }

  console.log("\n--- APPLY ---\n");

  for (const row of candidates) {
    await db
      .from("companies")
      .update({ status: "enriching", park_reason: null })
      .eq("id", row.company_id!);

    const nextAt = new Date().toISOString();
    await state.transition(
      row.id,
      "parked",
      "enriching",
      "unpark_enrichment_retry",
      { reason: "tooling_failure_disqualify_reason", next_action_at: nextAt },
      nextAt,
    );

    console.log(`unparked lead ${row.id} → enriching`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

