import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { db } from "@/lib/db";
import { createAnthropicClient } from "@/lib/integrations/anthropic";
import { createInstantlyClient } from "@/lib/integrations/instantly";
import { createTelegramClient } from "@/lib/integrations/telegram";
import { getActiveSetting } from "@/lib/settings";
import { transition } from "@/lib/state";
import type { DatabaseWithWebhooks } from "@/types/database-extensions";

import type { ClassifyDeps } from "./classify/core";
import { classifyJobDefinitions } from "./classify/jobs";

export {
  buildClassifierUserMessage,
  classifyReplyPayloadSchema,
  type ClassifyOutcome,
  runClassifyJob,
} from "./classify/core";
export { classifyJobDefinitions, type ClassifyDeps } from "./classify/jobs";
export { decide, type PolicyDecision } from "./classify/policy";

/**
 * Production deps for the reply classifier (09 §U7). The Instantly client is
 * narrowed to its stop operations, by type and at runtime: nothing reachable
 * from here can send or reply.
 */
export function createClassifyDeps(): ClassifyDeps {
  const telegram = createTelegramClient();
  const instantly = createInstantlyClient();
  return {
    db: db as unknown as SupabaseClient<DatabaseWithWebhooks>,
    anthropic: createAnthropicClient(),
    // Narrowed at runtime too: only the stop operations are copied over.
    instantly: {
      addBlockListEntry: instantly.addBlockListEntry,
      pauseCampaign: instantly.pauseCampaign,
      deleteLead: instantly.deleteLead,
      getLead: instantly.getLead,
      findLeadInCampaign: instantly.findLeadInCampaign,
    },
    transition,
    getActiveSetting,
    alert: (text) => telegram.sendAlert(text),
  };
}

/** U9's worker registry calls this. */
export function classifyJobs() {
  return classifyJobDefinitions(createClassifyDeps());
}
