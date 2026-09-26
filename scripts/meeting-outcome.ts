/**
 * scripts/meeting-outcome.ts — 09 §U8: the operator records what Calendly's
 * API does not expose (brief §9 Calendly row: "manual held/no-show recording").
 *
 *   pnpm exec tsx scripts/meeting-outcome.ts --meeting <uuid> --held              (dry run, reads only)
 *   pnpm exec tsx scripts/meeting-outcome.ts --meeting <uuid> --no-show           (dry run, reads only)
 *   pnpm exec tsx scripts/meeting-outcome.ts --meeting <uuid> --held --apply [--by <name>]
 *
 * --apply writes meetings.status (held | no_show), outcome_recorded_by/at
 * (an operator-reported value, brief §11) and a lead_event
 * (`meeting_held` / `meeting_no_show`, source "operator"). It never changes the
 * lead's state and never creates a job: an outcome does not restart outreach.
 * Canceled / rescheduled meetings and meetings that have not started are
 * refused. No provider call is made.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import { getMeeting, type OutcomeStatus, planOutcome, recordOutcome } from "../src/lib/meetings/core";
import type { DatabaseWithWave1 } from "../src/types/database-extensions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = "Usage: tsx scripts/meeting-outcome.ts --meeting <uuid> (--held | --no-show) [--apply] [--by <name>]";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const meetingId = arg("--meeting");
  const held = process.argv.includes("--held");
  const noShow = process.argv.includes("--no-show");
  const apply = process.argv.includes("--apply");
  const by = (arg("--by") ?? "operator:cli").slice(0, 100);
  if (!meetingId || !UUID.test(meetingId) || held === noShow) {
    console.error(USAGE);
    process.exit(2);
  }
  const to: OutcomeStatus = held ? "held" : "no_show";

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const db = createServiceClient(url, key) as unknown as SupabaseClient<DatabaseWithWave1>;
  const now = new Date();

  const row = await getMeeting(db, meetingId);
  if (!row) {
    console.error(`No meeting ${meetingId}.`);
    process.exit(1);
  }
  console.log(
    `meeting ${row.id} · ${row.status} · ${row.invitee_email} · ${row.event_name ?? "—"} · start ${row.start_at ?? "unknown"} · lead ${row.lead_id ?? "none"}`,
  );
  const plan = planOutcome(row, to, by, now);
  if (!plan.ok) {
    console.error(`Refused: ${plan.reason}`);
    process.exit(1);
  }
  if (plan.noop) {
    console.log(`Already ${to}; nothing to do.`);
    return;
  }
  console.log(`plan: ${plan.from} → ${to}; outcome_recorded_by=${by}; lead_event ${to === "held" ? "meeting_held" : "meeting_no_show"}${row.lead_id ? "" : " (no lead: skipped)"}; lead state unchanged`);
  if (!apply) {
    console.log("Dry run — nothing written. Re-run with --apply to record it.");
    return;
  }
  const result = await recordOutcome(db, meetingId, to, by, now);
  console.log(`Recorded: status=${result.row.status} outcome_recorded_at=${result.row.outcome_recorded_at}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
