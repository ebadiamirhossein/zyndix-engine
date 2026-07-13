import "server-only";

import { db } from "@/lib/db";
import { createAnthropicClient } from "@/lib/integrations/anthropic";
import { getActiveSetting } from "@/lib/settings";
import { transition } from "@/lib/state";

import { runQualifyStage, type QualifyStageSummary } from "./qualify/core";

export { runQualifyStage, type QualifyStageSummary } from "./qualify/core";

export async function qualifyStage(options?: {
  limit?: number;
}): Promise<QualifyStageSummary> {
  const anthropic = createAnthropicClient();
  return runQualifyStage(
    {
      db,
      anthropic,
      getActiveSetting,
      transition,
    },
    options,
  );
}
