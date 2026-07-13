import "server-only";

import { db } from "@/lib/db";
import { createMillionVerifierClient } from "@/lib/integrations/millionverifier";
import { transition } from "@/lib/state";

import { runVerifyStage, type VerifyStageSummary } from "./verify/core";

export { runVerifyStage, type VerifyStageSummary } from "./verify/core";

export async function verifyStage(options?: {
  limit?: number;
}): Promise<VerifyStageSummary> {
  const millionverifier = createMillionVerifierClient();
  return runVerifyStage(
    {
      db,
      millionverifier,
      transition,
    },
    options,
  );
}

