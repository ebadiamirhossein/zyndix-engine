import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { db } from "@/lib/db";
import { createApifyClient } from "@/lib/integrations/apify";
import { getActiveSetting } from "@/lib/settings";
import type { DatabaseWithWave1 } from "@/types/database-extensions";

import { researchJobDefinitions, type ResearchDeps } from "./research/jobs";

// 09 §UR server facade. Research runs inside the enrich stage
// (stages/enrich/core.ts → runResearchForLeads); researchJobs() registers
// nothing (see research/jobs.ts) but keeps the contract U9's registry uses.

export { researchJobDefinitions, type ResearchDeps } from "./research/jobs";
export { loadResearchPolicy, runResearchForLeads, type ResearchSummary } from "./research/run";

/** Production deps. The Apify token is read at call time, never here. */
export function createResearchDeps(): ResearchDeps {
  return {
    db: db as unknown as SupabaseClient<DatabaseWithWave1>,
    apify: createApifyClient(),
    getActiveSetting,
  };
}

export function researchJobs() {
  return researchJobDefinitions(createResearchDeps());
}
