import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import { createInstantlyReadClient, InstantlyError } from "../src/lib/integrations/instantly";
import { checkSenderDomain } from "../src/lib/sending/guard";
import { SEED_META, send_policy } from "../src/lib/settings/seed-content";
import { sendPolicySchema } from "../src/lib/validation/jsonb";
import type { Json } from "../src/types/database";
import type { DatabaseWithSending } from "../src/types/database-extensions";

// Seeds the four real sending mailboxes into send_accounts and the send_policy
// v1 settings row (09 §U5). DRY RUN BY DEFAULT: prints what it would write.
//
//   pnpm tsx scripts/seed-send-accounts.ts            dry run (reads only)
//   pnpm tsx scripts/seed-send-accounts.ts --apply    writes — operator approval first
//   pnpm tsx scripts/seed-send-accounts.ts --signatures [--apply]
//                                                     plain-text signatures only (0009, Session 12):
//                                                     prints the exact texts; --apply writes them
//
// Idempotent: an existing mailbox row (case-insensitive) or an active
// send_policy is left alone. ramp_started_on stays null — the first real
// reservation starts the ramp. Each mailbox must pass the sender guard and
// exist in Instantly (read-only check) or nothing is written.

const MAILBOXES = [
  "amir@zyndixhq.com",
  "ingrida@zyndixhq.com",
  "amir@getzyndix.com",
  "ingrida@getzyndix.com",
] as const;

const apply = process.argv.includes("--apply");
const signaturesOnly = process.argv.includes("--signatures");

// Operator-approved texts (Session 12). Same person, same signature on both
// domains. Changing one after a touch is approved makes that touch stale.
const SIGNATURES: Readonly<Record<(typeof MAILBOXES)[number], string>> = {
  "amir@zyndixhq.com": "Amir Ebadi\nZyndix, Vilnius\nzyndix.com",
  "amir@getzyndix.com": "Amir Ebadi\nZyndix, Vilnius\nzyndix.com",
  "ingrida@zyndixhq.com": "Ingrida Silobrit\nZyndix, Vilnius\nzyndix.com",
  "ingrida@getzyndix.com": "Ingrida Silobrit\nZyndix, Vilnius\nzyndix.com",
};

async function seedSignatures(db: SupabaseClient<DatabaseWithSending>): Promise<void> {
  console.log(`=== seed-send-accounts --signatures (${apply ? "APPLY" : "dry run"}) ===`);
  const plan: Array<{ id: string; identifier: string; text: string }> = [];
  for (const identifier of MAILBOXES) {
    const { data, error } = await db
      .from("send_accounts")
      .select("id, identifier, signature_text")
      .ilike("identifier", identifier)
      .maybeSingle();
    if (error) throw new Error(`read send_accounts: ${error.message}`);
    if (!data) throw new Error(`${identifier}: no send_accounts row — nothing written`);
    const text = SIGNATURES[identifier];
    console.log(`\n${identifier}  (current: ${data.signature_text === null ? "none" : JSON.stringify(data.signature_text)})`);
    console.log(text.split("\n").map((line) => `  | ${line}`).join("\n"));
    if (data.signature_text === text) {
      console.log("  SKIP (already set)");
      continue;
    }
    plan.push({ id: data.id, identifier, text });
  }
  if (!apply) {
    console.log(`\nDry run: ${plan.length} signature(s) would be written. Re-run with --apply after operator approval.`);
    return;
  }
  for (const row of plan) {
    const { error } = await db.from("send_accounts").update({ signature_text: row.text }).eq("id", row.id);
    if (error) throw new Error(`write signature ${row.identifier}: ${error.message}`);
    console.log(`WROTE  send_accounts.signature_text ${row.identifier}`);
  }
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  const db = createServiceClient(url, key) as unknown as SupabaseClient<DatabaseWithSending>;
  if (signaturesOnly) return seedSignatures(db);
  const instantly = createInstantlyReadClient();

  console.log(`=== seed-send-accounts (${apply ? "APPLY" : "dry run"}) ===`);

  const plan: Array<{ identifier: string; domain: string }> = [];
  let blocked = false;
  for (const identifier of MAILBOXES) {
    const guard = checkSenderDomain(identifier);
    if (!guard.ok) {
      console.log(`REFUSE ${identifier}: ${guard.reason}`);
      blocked = true;
      continue;
    }
    try {
      const account = await instantly.getAccount(identifier);
      console.log(`instantly: ${identifier} status=${account.status} warmup=${account.warmup_status ?? "?"} daily_limit=${account.daily_limit ?? "?"}`);
    } catch (error) {
      console.log(`REFUSE ${identifier}: not readable in Instantly (${error instanceof InstantlyError ? error.name : "error"})`);
      blocked = true;
      continue;
    }
    const { data: existing, error } = await db
      .from("send_accounts")
      .select("id, identifier, instantly_campaign_id")
      .ilike("identifier", identifier)
      .maybeSingle();
    if (error) throw new Error(`read send_accounts: ${error.message}`);
    if (existing) {
      console.log(`SKIP   ${identifier} (row ${existing.id} exists)`);
      continue;
    }
    plan.push({ identifier, domain: guard.domain });
    console.log(`PLAN   insert send_accounts ${identifier} kind=email provider=instantly health=ok ramp_started_on=null`);
  }

  const policy = sendPolicySchema.parse(send_policy);
  const { data: activePolicy, error: policyError } = await db
    .from("settings")
    .select("version")
    .eq("key", "send_policy")
    .eq("active", true)
    .maybeSingle();
  if (policyError) throw new Error(`read settings: ${policyError.message}`);
  const seedPolicy = !activePolicy;
  console.log(
    seedPolicy ? `PLAN   insert settings send_policy v1 ${JSON.stringify(policy)}` : `SKIP   send_policy (v${activePolicy.version} active)`,
  );

  if (blocked) throw new Error("one or more mailboxes refused — nothing written");
  if (!apply) {
    console.log("\nDry run: nothing written. Re-run with --apply after operator approval.");
    return;
  }

  for (const row of plan) {
    const { error } = await db.from("send_accounts").insert({
      kind: "email",
      identifier: row.identifier,
      domain: row.domain,
      provider: "instantly",
      health: "ok",
      ramp_stage: "warmup",
      ramp_started_on: null,
    });
    if (error) throw new Error(`insert ${row.identifier}: ${error.message}`);
    console.log(`WROTE  send_accounts ${row.identifier}`);
  }
  if (seedPolicy) {
    const { error } = await db.from("settings").insert({
      key: "send_policy",
      version: 1,
      value: policy as unknown as Json,
      active: true,
      changed_by: SEED_META.changed_by,
      change_note: "send_policy v1 (U5): verification 90d, no catch-all, warmup score >= 80, company window 30d",
    });
    if (error) throw new Error(`insert send_policy: ${error.message}`);
    console.log("WROTE  settings send_policy v1");
  }
}

main().catch((error: unknown) => {
  console.error("seed-send-accounts FAILED:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
