import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { db } from "@/lib/db";
import { createInstantlyClient } from "@/lib/integrations/instantly";
import { createTelegramClient } from "@/lib/integrations/telegram";
import { getActiveSetting } from "@/lib/settings";
import { transition } from "@/lib/state";
import type { DatabaseWithWebhooks } from "@/types/database-extensions";

import type { InstantlyWebhookDeps } from "./instantly";

/** Production deps for /api/webhooks/instantly. The secret is read per request, never logged. */
export function createInstantlyWebhookDeps(): InstantlyWebhookDeps {
  const telegram = createTelegramClient();
  const instantly = createInstantlyClient();
  return {
    db: db as unknown as SupabaseClient<DatabaseWithWebhooks>,
    secret: process.env.INSTANTLY_WEBHOOK_SECRET,
    transition,
    instantly: { addBlockListEntry: instantly.addBlockListEntry, pauseCampaign: instantly.pauseCampaign },
    getActiveSetting,
    alert: (text) => telegram.sendAlert(text),
  };
}
