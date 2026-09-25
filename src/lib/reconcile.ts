import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { db } from "@/lib/db";
import { createInstantlyClient } from "@/lib/integrations/instantly";
import { createTelegramClient } from "@/lib/integrations/telegram";
import { getActiveSetting } from "@/lib/settings";
import { transition } from "@/lib/state";
import type { DatabaseWithWebhooks } from "@/types/database-extensions";

import type { ReconcileDeps } from "./reconcile/core";
import { reconcileJobDefinitions } from "./reconcile/jobs";

export {
  REPLY_POLL_JOB_TYPE,
  runReplyPoll,
  runStaleStopCheck,
  STALE_STOP_JOB_TYPE,
  type ReconcileDeps,
  type ReplyPollSummary,
} from "./reconcile/core";
export { reconcileJobDefinitions } from "./reconcile/jobs";

/** Production deps. Nothing calls this until U9 wires the worker to cron. */
export function createReconcileDeps(): ReconcileDeps {
  const telegram = createTelegramClient();
  return {
    db: db as unknown as SupabaseClient<DatabaseWithWebhooks>,
    instantly: createInstantlyClient(),
    transition,
    getActiveSetting,
    alert: (text) => telegram.sendAlert(text),
  };
}

export function reconcileJobs() {
  return reconcileJobDefinitions(createReconcileDeps());
}
