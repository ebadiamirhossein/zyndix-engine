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
import { checkSenderDomain } from "../src/lib/sending/guard";
import { capacity_defaults } from "../src/lib/settings/seed-content";
import type { DatabaseWithSending } from "../src/types/database-extensions";

// Sender pinning, provider side (09 §U5): ONE single-step Instantly campaign
// per send_account, whose email_list is exactly that mailbox. Step 1 is
// enrolled into it with the approved subject/body as lead variables; steps
// >= 2 go out with POST /api/v2/emails/reply from the same mailbox.
//
//   pnpm tsx scripts/instantly-sender-campaigns.ts            dry run: payloads + current state (reads only)
//   pnpm tsx scripts/instantly-sender-campaigns.ts --verify   read-only diff of live config vs desired
//   pnpm tsx scripts/instantly-sender-campaigns.ts --apply    CREATES missing campaigns — operator approval first
//
// --apply writes to Instantly (POST /api/v2/campaigns) and records the id in
// send_accounts.instantly_campaign_id. Campaigns are created, never activated:
// nothing sends until U6 activates one for the live drill. No lead is added.

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const verify = args.has("--verify");

export function campaignName(identifier: string): string {
  return `zx-sender-${identifier.toLowerCase()}`;
}

/**
 * The desired campaign. Tracking off (operator decision 2026-09-25: no custom
 * tracking domain, opens are not a signal); first email text-only; stop on
 * reply and for the whole company; engine-owned timing, so the schedule is
 * open all week — the engine only enrolls inside the recipient's window.
 */
export function desiredCampaign(identifier: string): CreateCampaignInput {
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
    sequences: [
      { steps: [{ type: "email", delay: 0, variants: [{ subject: "{{zx_subject}}", body: "{{zx_body}}" }] }] },
    ],
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
export function diffCampaign(live: InstantlyCampaignDetail, identifier: string): string[] {
  const want = desiredCampaign(identifier);
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
  const steps = live.sequences?.[0]?.steps ?? [];
  const variant = steps[0]?.variants?.[0];
  if (steps.length !== 1 || variant?.subject !== "{{zx_subject}}" || variant?.body !== "{{zx_body}}") {
    problems.push(`sequence is not the single {{zx_subject}}/{{zx_body}} step (${steps.length} steps)`);
  }
  return problems;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  const db = createServiceClient(url, key) as unknown as SupabaseClient<DatabaseWithSending>;
  const instantly = createInstantlyClient();

  console.log(`=== instantly-sender-campaigns (${apply ? "APPLY" : verify ? "verify, read-only" : "dry run, read-only"}) ===`);

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
    const guard = checkSenderDomain(identifier);
    if (!guard.ok) {
      console.log(`REFUSE ${identifier}: ${guard.reason}`);
      failures += 1;
      continue;
    }
    const name = campaignName(identifier);
    const linkedId = account.instantly_campaign_id ?? byName.get(name)?.id ?? null;

    if (linkedId) {
      const live = await instantly.getCampaign(linkedId);
      const problems = diffCampaign(live, identifier);
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

    const payload = desiredCampaign(identifier);
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
    const problems = diffCampaign(created, identifier);
    if (problems.length) {
      console.log(`DRIFT  on create: ${problems.join("; ")}`);
      failures += 1;
    }
    if (created.status === 1) {
      console.log(`WARN   ${created.id} is ACTIVE on create — pause it before any lead is added`);
      failures += 1;
    }
  }

  if (failures > 0) {
    console.log(`\nRESULT: ${failures} problem(s)`);
    process.exit(1);
  }
  console.log(apply ? "\nRESULT: applied" : "\nRESULT: pass (nothing written)");
}

main().catch((error: unknown) => {
  const message = error instanceof InstantlyError ? `${error.name}: ${error.message}` : error instanceof Error ? error.message : String(error);
  console.error("instantly-sender-campaigns FAILED:", message);
  process.exit(1);
});
