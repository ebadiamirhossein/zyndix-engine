/**
 * scripts/hold-lead.ts — 09 §U6c S21: the operator's manual hold.
 *
 *   pnpm exec tsx scripts/hold-lead.ts --lead <uuid>            (dry run, reads only)
 *   pnpm exec tsx scripts/hold-lead.ts --lead <uuid> --apply    (writes + a LIVE Instantly DELETE)
 *
 * --apply moves the lead → manual_hold through lib/state and then calls
 * stopSequence: its unsent follow-ups are killed and, if it holds a live
 * Instantly enrollment, the lead is DELETEd from the campaign and confirmed
 * gone (GET 404 + leads/list 0). A stop that cannot be confirmed is escalated
 * and pauses that sender's campaign. The DELETE is a live Instantly write:
 * run --apply only with the operator's OK (CLAUDE.md cost and safety gate).
 * S22 uses this for its "manual hold → DELETE → 404" step. A Telegram /hold
 * command is backlog (09 §5).
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import { createInstantlyClient } from "../src/lib/integrations/instantly";
import { createTelegramClient } from "../src/lib/integrations/telegram";
import { holdAndStop } from "../src/lib/sending/stop";
import { createStateStore } from "../src/lib/state/core";
import type { Database } from "../src/types/database";
import type { DatabaseWithEnrollments, DatabaseWithWebhooks } from "../src/types/database-extensions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const leadId = arg("--lead");
  const apply = process.argv.includes("--apply");
  if (!leadId || !UUID.test(leadId)) {
    console.error("Usage: tsx scripts/hold-lead.ts --lead <uuid> [--apply]");
    process.exit(2);
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const raw = createServiceClient(url, key);
  const db = raw as unknown as SupabaseClient<DatabaseWithWebhooks>;

  const { data: lead, error } = await db.from("leads").select("id, state, send_account_id").eq("id", leadId).maybeSingle();
  if (error) throw new Error(`load lead: ${error.message}`);
  if (!lead) {
    console.error(`No lead ${leadId}.`);
    process.exit(1);
  }
  const { data: enrollments, error: enrollError } = await (raw as unknown as SupabaseClient<DatabaseWithEnrollments>)
    .from("instantly_enrollments")
    .select("id, state, campaign_id, provider_lead_id, stop_reason")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false });
  if (enrollError) throw new Error(`load enrollments: ${enrollError.message}`);
  const { data: followups, error: touchError } = await db
    .from("touches")
    .select("id, step_no, status")
    .eq("lead_id", leadId)
    .eq("direction", "outbound")
    .gte("step_no", 2);
  if (touchError) throw new Error(`load touches: ${touchError.message}`);

  const live = (enrollments ?? []).filter((e) => ["active", "stopping", "stop_failed"].includes(e.state));
  console.log(`lead ${lead.id} · state ${lead.state}`);
  console.log(`enrollments: ${JSON.stringify(enrollments ?? [])}`);
  console.log(`follow-up touches: ${JSON.stringify(followups ?? [])}`);
  console.log(
    `plan: ${lead.state === "manual_hold" || lead.state === "suppressed" ? "state unchanged" : `${lead.state} → manual_hold (manual_hold_by_operator)`}; ` +
      `kill unsent follow-ups; ${live.length ? `DELETE Instantly lead ${live[0]!.provider_lead_id ?? "(looked up by email)"} in ${live[0]!.campaign_id}, then GET 404 + leads/list 0` : "no live enrollment → no Instantly call"}`,
  );
  if (!apply) {
    console.log("(dry-run) Add --apply to hold the lead and stop its sequence (a live Instantly DELETE when enrolled).");
    return;
  }

  const telegram = createTelegramClient();
  const result = await holdAndStop(
    {
      db,
      instantly: createInstantlyClient(),
      transition: createStateStore(raw as SupabaseClient<Database>).transition,
      alert: (text) => telegram.sendAlert(text),
    },
    leadId,
    "manual_hold_by_operator",
    { source: "scripts/hold-lead.ts" },
  );
  console.log(`APPLIED ${JSON.stringify(result)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
