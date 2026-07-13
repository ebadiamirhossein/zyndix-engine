import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import {
  ApolloApiError,
  ApolloPlanError,
  createApolloClient,
} from "../src/lib/integrations/apollo";
import type { ApolloSegmentQuery } from "../src/lib/integrations/apollo-types";
import { createServiceClient } from "../src/lib/db/service-client";
import { segmentsSettingsSchema } from "../src/lib/validation/jsonb";
import { parseOrThrow } from "../src/lib/validation";
import { createSettingsStore } from "../src/lib/settings/core";
import { PROPOSED_US_REALESTATE_APOLLO_QUERY } from "./proposed-us-realestate-query";

const apply = process.argv.includes("--apply");
const dryRun = !apply;

const FALLBACK_INDUSTRY = ["real estate"] as const;

function orgDomain(org: {
  primary_domain?: string | null;
  website_url?: string | null;
}): string | null {
  if (org.primary_domain) {
    return org.primary_domain.toLowerCase();
  }
  if (org.website_url) {
    try {
      return new URL(org.website_url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

function printOrgSample(
  label: string,
  query: ApolloSegmentQuery,
  totalEntries: number,
  orgs: { name: string; primary_domain?: string | null; website_url?: string | null }[],
): void {
  console.log(`\n=== ${label} ===`);
  console.log(`Query: ${JSON.stringify(query)}`);
  console.log(`Total org count: ${totalEntries}`);
  console.log("First 10 companies (name | domain):");
  for (const org of orgs.slice(0, 10)) {
    const domain = orgDomain(org) ?? "(no domain)";
    console.log(`  - ${org.name} | ${domain}`);
  }
}

async function probeApolloQuery(
  apollo: ReturnType<typeof createApolloClient>,
  query: ApolloSegmentQuery,
): Promise<{ totalEntries: number; organizations: Awaited<ReturnType<typeof apollo.searchOrganizationsWithMeta>>["organizations"] }> {
  const result = await apollo.searchOrganizationsWithMeta(query, {
    page: 1,
    perPage: 25,
  });
  return result;
}

async function runDryRun(): Promise<void> {
  if (!process.env.APOLLO_API_KEY) {
    console.error("Missing APOLLO_API_KEY in .env.local");
    process.exit(1);
  }

  const apollo = createApolloClient();
  const proposedQuery: ApolloSegmentQuery = {
    ...PROPOSED_US_REALESTATE_APOLLO_QUERY,
    industry: [...PROPOSED_US_REALESTATE_APOLLO_QUERY.industry],
    employee_range: [...PROPOSED_US_REALESTATE_APOLLO_QUERY.employee_range],
    exclude_keywords: [...PROPOSED_US_REALESTATE_APOLLO_QUERY.exclude_keywords],
    titles: [...PROPOSED_US_REALESTATE_APOLLO_QUERY.titles],
  };

  console.log("=== Proposed us-realestate.apollo_query (settings v3) ===");
  console.log(JSON.stringify(proposedQuery, null, 2));
  console.log(
    "\nexclude_keywords are applied post-search in source stage (not in this Apollo probe).",
  );

  const proposed = await probeApolloQuery(apollo, proposedQuery);
  printOrgSample(
    "Proposed industry tags",
    proposedQuery,
    proposed.totalEntries,
    proposed.organizations,
  );

  let fallback: Awaited<ReturnType<typeof probeApolloQuery>> | null = null;
  let winner: "proposed" | "fallback" = proposed.totalEntries > 0 ? "proposed" : "fallback";

  if (proposed.totalEntries === 0) {
    const fallbackQuery: ApolloSegmentQuery = {
      ...proposedQuery,
      industry: [...FALLBACK_INDUSTRY],
    };
    fallback = await probeApolloQuery(apollo, fallbackQuery);
    printOrgSample(
      'Fallback industry ["real estate"] (v1)',
      fallbackQuery,
      fallback.totalEntries,
      fallback.organizations,
    );
    winner = fallback.totalEntries > 0 ? "fallback" : "proposed";
  }

  console.log("\n=== Summary ===");
  console.log(`Proposed industry org count: ${proposed.totalEntries}`);
  if (fallback) {
    console.log(`Fallback ["real estate"] org count: ${fallback.totalEntries}`);
  } else {
    console.log("Fallback not needed (proposed query returned results).");
  }

  const sample =
    winner === "proposed" && proposed.totalEntries > 0
      ? proposed
      : fallback && fallback.totalEntries > 0
        ? fallback
        : proposed;

  const winnerLabel =
    winner === "proposed" && proposed.totalEntries > 0
      ? "proposed industry tags"
      : fallback && fallback.totalEntries > 0
        ? 'fallback industry ["real estate"]'
        : "neither query returned orgs";

  console.log(`Query with results: ${winnerLabel}`);
  if (sample.totalEntries > 0) {
    console.log("Sample companies from winning query:");
    for (const org of sample.organizations.slice(0, 10)) {
      const domain = orgDomain(org) ?? "(no domain)";
      console.log(`  - ${org.name} | ${domain}`);
    }
  }

  console.log("\nDry run complete. Re-run with --apply after approval to write settings v3.");
}

async function runApply(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  const db = createServiceClient(url, key);
  const settings = createSettingsStore(db);

  const current = await settings.getActiveSetting("segments");
  const segments = parseOrThrow(segmentsSettingsSchema, current.value, "segments");

  if (!segments["us-realestate"]) {
    throw new Error("us-realestate segment missing from active settings");
  }

  const nextSegments = {
    ...segments,
    "us-realestate": {
      ...segments["us-realestate"],
      apollo_query: { ...PROPOSED_US_REALESTATE_APOLLO_QUERY },
    },
  };

  const written = await settings.writeNewVersion(
    "segments",
    nextSegments,
    "amir",
    "v3: expand exclude_keywords, drop president from titles",
  );

  console.log(`Wrote segments v${written.version} (active).`);
}

async function main(): Promise<void> {
  if (dryRun) {
    await runDryRun();
    return;
  }
  await runApply();
}

main().catch((error: unknown) => {
  if (error instanceof ApolloPlanError || error instanceof ApolloApiError) {
    console.error("update-segment-query FAILED (Apollo):", error.message);
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("update-segment-query FAILED:", message);
  process.exit(1);
});
