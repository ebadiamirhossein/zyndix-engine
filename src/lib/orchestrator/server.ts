import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { db } from "@/lib/db";
import { createInstantlyClient } from "@/lib/integrations/instantly";
import { createTelegramClient } from "@/lib/integrations/telegram";
import { jobQueue } from "@/lib/jobs";
import type { JobRegistry } from "@/lib/jobs/registry";
import { researchJobs } from "@/lib/research";
import { reconcileJobs } from "@/lib/reconcile";
import { clearSettingsCache, getActiveSetting } from "@/lib/settings";
import { classifyJobs } from "@/lib/stages/classify";
import { draftStage } from "@/lib/stages/draft";
import { enrichStage } from "@/lib/stages/enrich";
import { qualifyStage } from "@/lib/stages/qualify";
import { sendJobs } from "@/lib/stages/send";
import { sourceStage } from "@/lib/stages/source";
import { verifyStage } from "@/lib/stages/verify";
import { transition } from "@/lib/state";
import type { DatabaseWithJobs, DatabaseWithSending, DatabaseWithWebhooks } from "@/types/database-extensions";

import type { DailyDeps } from "./daily";
import { readOperationsPause } from "./pause";
import { buildJobRegistry } from "./registry";
import type { CronDeps } from "./run";
import { runSendEnqueueStage } from "./send-enqueue";
import { createLeaseProbe, stageJobDefinitions } from "./stages";

// Production wiring for the cron routes (09 §U9). Everything here builds
// real clients; the cores in run.ts / daily.ts take these as deps.

const readPause = () => readOperationsPause(getActiveSetting);

/** Every job type the engine runs, with production deps. */
export function productionRegistry(): JobRegistry {
  return buildJobRegistry({
    send: sendJobs(),
    reconcile: reconcileJobs(),
    classify: classifyJobs(),
    research: researchJobs(),
    stages: stageJobDefinitions({
      runners: {
        source: (o) => sourceStage(o),
        enrich: (o) => enrichStage(o),
        qualify: (o) => qualifyStage(o),
        verify: (o) => verifyStage(o),
        draft: (o) => draftStage(o),
        send_enqueue: (o) =>
          runSendEnqueueStage(
            { db: db as unknown as SupabaseClient<DatabaseWithSending>, queue: jobQueue, readPause },
            o,
          ),
      },
      countLeased: createLeaseProbe(db as unknown as SupabaseClient<DatabaseWithJobs>),
      readPause,
    }),
  });
}

/**
 * Deps for /api/cron/{orchestrate,safety}. The settings cache is cleared per
 * invocation, so a pause set from another instance is seen at the start of
 * the run; inside a run the 60 s cache applies to the per-claim pause check.
 */
export function createCronDeps(): CronDeps {
  clearSettingsCache();
  return { queue: jobQueue, registry: productionRegistry, getActiveSetting };
}

/** Deps for /api/cron/daily: checkBounceRate's stop deps (it may pause a sender). */
export function createDailyDeps(): DailyDeps {
  clearSettingsCache();
  const telegram = createTelegramClient();
  const instantly = createInstantlyClient();
  return {
    db: db as unknown as SupabaseClient<DatabaseWithWebhooks>,
    instantly: {
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
