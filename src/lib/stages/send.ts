import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { db } from "@/lib/db";
import { createInstantlyClient } from "@/lib/integrations/instantly";
import { createTelegramClient } from "@/lib/integrations/telegram";
import { jobQueue } from "@/lib/jobs";
import { capacityLedger } from "@/lib/scheduler";
import { getActiveSetting } from "@/lib/settings";
import { transition } from "@/lib/state";
import type { DatabaseWithSending } from "@/types/database-extensions";

import type { SendDeps } from "./send/core";
import { sendJobDefinitions } from "./send/jobs";

export {
  enqueueSend,
  RECONCILE_JOB_TYPE,
  runReconcileJob,
  runSendJob,
  SEND_JOB_TYPE,
  type SendDeps,
  type SendOutcome,
} from "./send/core";
export { sendJobDefinitions } from "./send/jobs";

/**
 * Production deps for the send stage. Nothing calls this until U9 wires the
 * worker to cron; U5 ships the stage, not the schedule.
 */
export function createSendDeps(): SendDeps {
  const telegram = createTelegramClient();
  return {
    db: db as unknown as SupabaseClient<DatabaseWithSending>,
    instantly: createInstantlyClient(),
    ledger: capacityLedger,
    queue: jobQueue,
    transition,
    getActiveSetting,
    alert: (text) => telegram.sendAlert(text),
  };
}

export function sendJobs() {
  return sendJobDefinitions(createSendDeps());
}
