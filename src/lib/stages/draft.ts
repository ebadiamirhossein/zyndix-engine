import "server-only";

import { db } from "@/lib/db";
import { createAnthropicClient } from "@/lib/integrations/anthropic";
import { createTelegramClient } from "@/lib/integrations/telegram";
import { getActiveSetting } from "@/lib/settings";
import { transition } from "@/lib/state";

import { runDraftStage, type DraftStageSummary } from "./draft/core";

export { runDraftStage, type DraftStageSummary } from "./draft/core";

export async function draftStage(options?: {
  limit?: number;
}): Promise<DraftStageSummary> {
  const anthropic = createAnthropicClient();
  const telegram = createTelegramClient();
  return runDraftStage(
    {
      db,
      anthropic,
      telegram,
      getActiveSetting,
      transition,
    },
    options,
  );
}
