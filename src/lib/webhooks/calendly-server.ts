import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { db } from "@/lib/db";
import { createInstantlyClient } from "@/lib/integrations/instantly";
import { createTelegramClient } from "@/lib/integrations/telegram";
import { transition } from "@/lib/state";
import type { DatabaseWithWave1 } from "@/types/database-extensions";

import type { CalendlyWebhookDeps } from "./calendly";

/**
 * Production deps for /api/webhooks/calendly. The signing key is read per
 * request, never logged. Instantly is only used to stop a booked lead's
 * sequence (DELETE + confirming reads); no model or send client exists here.
 */
export function createCalendlyWebhookDeps(): CalendlyWebhookDeps {
  const telegram = createTelegramClient();
  const instantly = createInstantlyClient();
  return {
    db: db as unknown as SupabaseClient<DatabaseWithWave1>,
    signingKey: process.env.CALENDLY_WEBHOOK_SIGNING_KEY,
    transition,
    instantly: {
      pauseCampaign: instantly.pauseCampaign,
      deleteLead: instantly.deleteLead,
      getLead: instantly.getLead,
      findLeadInCampaign: instantly.findLeadInCampaign,
    },
    alert: (text) => telegram.sendAlert(text),
  };
}
