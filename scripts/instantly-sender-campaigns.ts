import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import {
  createInstantlyClient,
  InstantlyError,
  type CreateCampaignInput,
} from "../src/lib/integrations/instantly";
import { CAMPAIGN_STATUS_LABELS, label, type InstantlyCampaignDetail } from "../src/lib/integrations/instantly-types";
import {
  diffCampaignSequence,
  engineTimings,
  instantlySequencePayload,
  planCampaignUpdate,
} from "../src/lib/sending/campaign-sequence";
import { checkSenderDomain } from "../src/lib/sending/guard";
import type { EmailSequence } from "../src/lib/sending/sequence-approval";
import { createSettingsStore } from "../src/lib/settings/core";
import { capacity_defaults } from "../src/lib/settings/seed-content";
import { emailSequenceSchema } from "../src/lib/validation/jsonb";
import type { Database } from "../src/types/database";
import type { DatabaseWithSending } from "../src/types/database-extensions";

// Sender pinning, provider side (09 §U5): ONE Instantly campaign per
// send_account, whose email_list is exactly that mailbox. Step 1 is enrolled
// into it with every approved step's text as lead variables; steps >= 2 are
// the campaign's own sequence steps (09 §U6c), built from the ACTIVE
// email_sequence through the delay mapping (lib/sending/campaign-sequence.ts).
//
//   pnpm tsx scripts/instantly-sender-campaigns.ts                     dry run: payloads + current state (reads only)
//   pnpm tsx scripts/instantly-sender-campaigns.ts --verify            read-only diff of live config vs desired
//   pnpm tsx scripts/instantly-sender-campaigns.ts --apply             CREATES missing campaigns — operator approval first
//   pnpm tsx scripts/instantly-sender-campaigns.ts --update            dry run of the sequence PATCH (reads only)
//   pnpm tsx scripts/instantly-sender-campaigns.ts --update --apply --only <mailbox>
//                                                                      PATCHES one campaign's sequence — operator approval first
//
// --apply writes to Instantly (POST /api/v2/campaigns) and records the id in
// send_accounts.instantly_campaign_id. Campaigns are created, never activated.
// --update refuses unless the campaign is paused (or a never-run draft) AND
// holds 0 leads (campaign_not_paused / campaign_has_leads): adding steps
// reactivates previously completed leads. With --apply it PATCHes one
// campaign (--only is required), then re-reads and diffs it. No lead is added.

const argv = process.argv.slice(2);
const args = new Set(argv);
const apply = args.has("--apply");
const verify = args.has("--verify");
const update = args.has("--update");
const only = argv.includes("--only") ? (argv[argv.indexOf("--only") + 1] ?? "").toLowerCase() : null;

export function campaignName(identifier: string): string {
  return `zx-sender-${identifier.toLowerCase()}`;
}

/**
 * The desired campaign. Tracking off (operator decision 2026-09-25: no custom
 * tracking domain, opens are not a signal); text-only; stop on reply and for
 * the whole company; engine-owned timing, so the schedule is open all week —
 * the engine only enrolls inside the recipient's window, and 7-day follow-up
 * delays keep each step on step 1's weekday and local time (Session 17).
 */
export function desiredCampaign(identifier: string, sequence: EmailSequence): CreateCampaignInput {
  const quota = capacity_defaults.email_inbox.start_quota;
  return {
    name: campaignName(identifier),
    campaign_schedule: {
      schedules: [
        {
          name: "engine-owned timing",
          timing: { from: "00:00", to: "23:59" },
          days: { "0": true, "1": true, "2": true, "3": true, "4": true, "5": true, "6": true },
          timezone: "Europe/Helsinki",
        },
      ],
    },
    sequences: instantlySequencePayload(engineTimings(sequence)),
    email_list: [identifier],
    daily_limit: quota,
    daily_max_leads: quota,
    email_gap: 10,
    random_wait_max: 5,
    open_tracking: false,
    link_tracking: false,
    text_only: true,
    first_email_text_only: true,
    stop_on_reply: true,
    stop_on_auto_reply: false,
    stop_for_company: true,
    insert_unsubscribe_header: true,
  };
}

/** Differences between a live campaign and the desired config. Empty = compliant. */
export function diffCampaign(live: InstantlyCampaignDetail, identifier: string, sequence: EmailSequence): string[] {
  const want = desiredCampaign(identifier, sequence);
  const problems: string[] = [];
  const list = (live.email_list ?? []).map((e) => e.toLowerCase());
  if (list.length !== 1 || list[0] !== identifier.toLowerCase()) {
    problems.push(`email_list=${JSON.stringify(live.email_list ?? null)} (want exactly [${identifier}])`);
  }
  // Instantly omits false-valued optional flags from its responses (observed
  // 2026-09-25: link_tracking and stop_on_auto_reply, both sent false, come
  // back absent, while the required open_tracking:false is echoed). So
  // link_tracking is drift only if it is ever TRUE; absent is reported as
  // "not echoed" by the caller, never as proven off.
  if (live.link_tracking === true) problems.push("link_tracking=true (want false)");
  for (const field of [
    "open_tracking",
    "text_only",
    "first_email_text_only",
    "stop_on_reply",
    "stop_for_company",
    "insert_unsubscribe_header",
  ] as const) {
    if (live[field] !== want[field]) problems.push(`${field}=${String(live[field])} (want ${String(want[field])})`);
  }
  // 09 §U6c: the steps, delays (through the mapping) and templates.
  problems.push(...diffCampaignSequence(live.sequences?.[0]?.steps, engineTimings(sequence)).map((p) => `sequence: ${p}`));
  return problems;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  const raw = createServiceClient(url, key);
  const db = raw as unknown as SupabaseClient<DatabaseWithSending>;
  const instantly = createInstantlyClient();
  const mode = update ? (apply ? "UPDATE APPLY" : "update dry run, read-only") : apply ? "APPLY" : verify ? "verify, read-only" : "dry run, read-only";
  if (update && apply && !only) throw new Error("--update --apply needs --only <mailbox>: campaigns are PATCHed one at a time");

  const sequenceSetting = await createSettingsStore(raw as SupabaseClient<Database>).getActiveSetting("email_sequence" as never);
  const sequence = emailSequenceSchema.parse(sequenceSetting.value);
  console.log(`=== instantly-sender-campaigns (${mode}) · email_sequence v${sequenceSetting.version} ===`);

  const { data: accounts, error } = await db
    .from("send_accounts")
    .select("id, identifier, instantly_campaign_id")
    .eq("kind", "email")
    .eq("provider", "instantly")
    .order("identifier");
  if (error) throw new Error(`read send_accounts: ${error.message}`);
  if (!accounts || accounts.length === 0) {
    console.log("No send_accounts rows (provider=instantly). Run scripts/seed-send-accounts.ts first.");
    return;
  }

  const existing = (await instantly.listAllCampaigns()).items;
  console.log(`instantly campaigns: ${existing.length}`);
  const byName = new Map(existing.map((c) => [c.name, c]));

  let failures = 0;
  for (const account of accounts) {
    const identifier = account.identifier ?? "";
    if (only && identifier.toLowerCase() !== only) continue;
    const guard = checkSenderDomain(identifier);
    if (!guard.ok) {
      console.log(`REFUSE ${identifier}: ${guard.reason}`);
      failures += 1;
      continue;
    }
    const name = campaignName(identifier);
    const linkedId = account.instantly_campaign_id ?? byName.get(name)?.id ?? null;

    if (linkedId && update) {
      failures += await updateOne(instantly, identifier, linkedId, sequence);
      continue;
    }

    if (linkedId) {
      const live = await instantly.getCampaign(linkedId);
      const problems = diffCampaign(live, identifier, sequence);
      console.log(
        `${problems.length ? "DRIFT " : "OK    "} ${identifier} → ${live.id} "${live.name}" status=${label(CAMPAIGN_STATUS_LABELS, live.status)}` +
          ` email_list=${JSON.stringify(live.email_list)} open_tracking=${live.open_tracking} link_tracking=${live.link_tracking ?? "not echoed (sent false)"}` +
          ` text_only=${live.text_only} first_email_text_only=${live.first_email_text_only} stop_on_reply=${live.stop_on_reply} daily_limit=${live.daily_limit}` +
          (problems.length ? `\n         ${problems.join("\n         ")}` : ""),
      );
      if (problems.length) failures += 1;
      if (!account.instantly_campaign_id && apply) {
        const { error: linkError } = await db
          .from("send_accounts")
          .update({ instantly_campaign_id: live.id })
          .eq("id", account.id)
          .is("instantly_campaign_id", null);
        if (linkError) throw new Error(`link ${identifier}: ${linkError.message}`);
        console.log(`WROTE  send_accounts.instantly_campaign_id for ${identifier}`);
      } else if (!account.instantly_campaign_id) {
        console.log(`PLAN   link send_accounts ${identifier} → ${live.id}`);
      }
      continue;
    }

    if (update) {
      console.log(`SKIP   ${identifier}: no campaign to update`);
      continue;
    }
    const payload = desiredCampaign(identifier, sequence);
    if (!apply) {
      console.log(`PLAN   create campaign for ${identifier}:\n${JSON.stringify(payload, null, 2)}`);
      continue;
    }
    const created = await instantly.createCampaign(payload);
    console.log(`CREATED ${identifier} → ${created.id} status=${label(CAMPAIGN_STATUS_LABELS, created.status)}`);
    const { error: writeError } = await db
      .from("send_accounts")
      .update({ instantly_campaign_id: created.id })
      .eq("id", account.id)
      .is("instantly_campaign_id", null);
    if (writeError) throw new Error(`record ${identifier}: ${writeError.message}`);
    const problems = diffCampaign(created, identifier, sequence);
    if (problems.length) {
      console.log(`DRIFT  on create: ${problems.join("; ")}`);
      failures += 1;
    }
    if (created.status === 1) {
      console.log(`WARN   ${created.id} is ACTIVE on create — pause it before any lead is added`);
      failures += 1;
    }
  }

  if (only && !accounts.some((a) => (a.identifier ?? "").toLowerCase() === only)) {
    throw new Error(`--only ${only}: no such send_account`);
  }
  if (failures > 0) {
    console.log(`\nRESULT: ${failures} problem(s)`);
    process.exit(1);
  }
  console.log(apply ? "\nRESULT: applied" : "\nRESULT: pass (nothing written)");
}

/**
 * --update for one campaign: refuse unless paused/draft with 0 leads; print
 * the plan; with --apply, PATCH the sequence and re-verify. Returns the
 * number of problems (a refusal counts as one).
 */
async function updateOne(
  instantly: ReturnType<typeof createInstantlyClient>,
  identifier: string,
  campaignId: string,
  sequence: EmailSequence,
): Promise<number> {
  const live = await instantly.getCampaign(campaignId);
  const leads = await instantly.listCampaignLeads(campaignId, { limit: 1 });
  const status = label(CAMPAIGN_STATUS_LABELS, live.status);
  const plan = planCampaignUpdate(live, leads.items.length, engineTimings(sequence));
  if (!plan.ok) {
    console.log(`REFUSE ${identifier} → ${campaignId} status=${status} leads=${leads.items.length}${leads.items.length ? "+" : ""}: ${plan.reason}`);
    return 1;
  }
  if (plan.problems.length === 0) {
    console.log(`OK     ${identifier} → ${campaignId} status=${status} leads=0: sequence already matches, nothing to PATCH`);
    return 0;
  }
  console.log(
    `PLAN   PATCH ${campaignId} (${identifier}) status=${status} leads=0 — changes:\n         ${plan.problems.join("\n         ")}\n` +
      `       body: ${JSON.stringify(plan.payload)}`,
  );
  if (!apply) return 0;
  await instantly.updateCampaign(campaignId, plan.payload);
  const after = await instantly.getCampaign(campaignId);
  const problems = diffCampaign(after, identifier, sequence);
  console.log(problems.length ? `DRIFT  after PATCH: ${problems.join("; ")}` : `UPDATED ${campaignId}: --verify clean`);
  return problems.length;
}

main().catch((error: unknown) => {
  const message = error instanceof InstantlyError ? `${error.name}: ${error.message}` : error instanceof Error ? error.message : String(error);
  console.error("instantly-sender-campaigns FAILED:", message);
  process.exit(1);
});
