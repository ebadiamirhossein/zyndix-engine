import "server-only";

import { db } from "@/lib/db";
import { createApifyClient } from "@/lib/integrations/apify";
import { getActiveSetting } from "@/lib/settings";
import { transition } from "@/lib/state";

import { runEnrichStage, type EnrichStageSummary } from "./enrich/core";

export {
  ENRICHMENT_SOURCE,
  runEnrichStage,
  type EnrichStageSummary,
} from "./enrich/core";

export async function enrichStage(options?: {
  limit?: number;
}): Promise<EnrichStageSummary> {
  const apify = createApifyClient();
  return runEnrichStage(
    {
      db,
      apify,
      getActiveSetting,
      transition,
    },
    options,
  );
}
