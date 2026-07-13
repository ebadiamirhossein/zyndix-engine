import "server-only";

import { db } from "@/lib/db";
import { createApolloClient } from "@/lib/integrations/apollo";
import { getActiveSetting } from "@/lib/settings";

import { runSourceStage, type SourceStageSummary } from "./source/core";

export {
  PRE_SEND_STATES,
  runSourceStage,
  type SourceStageSummary,
} from "./source/core";

export async function sourceStage(options?: {
  limit?: number;
}): Promise<SourceStageSummary> {
  const apollo = createApolloClient();
  return runSourceStage(
    {
      db,
      apollo,
      getActiveSetting,
    },
    options,
  );
}
