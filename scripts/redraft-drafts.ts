import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import { type AnthropicClient, createAnthropicClient } from "../src/lib/integrations/anthropic";
import { createTelegramClient } from "../src/lib/integrations/telegram";
import { findSignOff } from "../src/lib/sending/approval";
import { createSettingsStore } from "../src/lib/settings/core";
import { wordCount } from "../src/lib/stages/draft/guard";
import { runDraftStage } from "../src/lib/stages/draft/core";
import { createStateStore } from "../src/lib/state/core";
import type { DatabaseWithSending } from "../src/types/database-extensions";
import type { LeadState } from "../src/types/enums";

// Redraft the 4 real drafts made under writer_prompt_email v7 (Session 13,
// operator request). Their bodies still end with the old footer's "— Amir",
// which approval now refuses, and Steffen's approval hash predates the
// signature binding (stale_approval).
//
// Dry-run by default: prints what would change and the Anthropic estimate.
// --apply, per lead:
//   1. the old touch → `killed` (never deleted), fenced on its current status;
//   2. lead → drafting via lib/state (`redraft_requested`, Session 13 edge);
//   3. then ONE runDraftStage scoped to these lead ids: real Anthropic with the
//      active prompt (v8), a fresh touch in pending_approval, and a Telegram
//      card to TELEGRAM_ALLOWED_USER_IDS (the operator only).
// A hard cost ceiling stops further model calls once the estimate passes
// $0.10. Approval afterwards only binds the touch; nothing sends (no worker
// until U9).

const TARGET_PREFIXES = ["5976b68f", "041142cc", "0f20b919", "b48ad46e"] as const;
const REDRAFT_FROM: readonly LeadState[] = ["pending_approval", "approved"];
const COST_CEILING_USD = 0.1;
/** Sessions 11–13: one writer call ≈ 1,515–1,578 tokens ≈ $0.0061–0.0066 at Sonnet 4.6 list price. */
const EST_PER_CALL_USD = 0.0066;

const apply = process.argv.includes("--apply");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const raw = createServiceClient(url, key);
const db = raw as unknown as SupabaseClient<DatabaseWithSending>;
const state = createStateStore(raw);
const settings = createSettingsStore(raw);

type Target = {
  leadId: string;
  company: string;
  state: LeadState;
  touchId: string;
  touchStatus: string;
  promptVersion: number | null;
  signOff: string | null;
};

async function loadTargets(): Promise<Target[]> {
  const { data: leads, error } = await db.from("leads").select("id, state, companies(name)");
  if (error) throw new Error(`load leads: ${error.message}`);
  const targets: Target[] = [];
  for (const prefix of TARGET_PREFIXES) {
    const matches = (leads ?? []).filter((l) => l.id.startsWith(prefix));
    if (matches.length !== 1) throw new Error(`prefix ${prefix}: ${matches.length} leads match, expected exactly 1`);
    const lead = matches[0]!;
    const { data: touches, error: touchError } = await db
      .from("touches")
      .select("id, status, prompt_version, draft_body, step_no, direction")
      .eq("lead_id", lead.id)
      .eq("direction", "outbound")
      .in("status", ["pending_approval", "approved"]);
    if (touchError) throw new Error(`load touches: ${touchError.message}`);
    if ((touches ?? []).length !== 1) throw new Error(`lead ${lead.id}: ${(touches ?? []).length} live outbound touches, expected exactly 1`);
    const touch = touches![0]!;
    targets.push({
      leadId: lead.id,
      company: (lead.companies as { name: string } | null)?.name ?? "?",
      state: lead.state as LeadState,
      touchId: touch.id,
      touchStatus: touch.status ?? "?",
      promptVersion: touch.prompt_version,
      signOff: findSignOff(touch.draft_body ?? ""),
    });
  }
  return targets;
}

async function preconditions(targets: Target[]): Promise<string[]> {
  const problems: string[] = [];
  for (const t of targets) {
    if (!REDRAFT_FROM.includes(t.state)) problems.push(`${t.leadId} is ${t.state}, not pending_approval/approved`);
    const { data: outbox } = await db.from("outbox").select("id").eq("lead_id", t.leadId);
    if ((outbox ?? []).length > 0) problems.push(`${t.leadId} has outbox rows — a dispatch was attempted; not redrafting`);
  }
  const { data: drafting } = await db.from("leads").select("id").eq("state", "drafting");
  if ((drafting ?? []).length > 0) problems.push(`${drafting!.length} lead(s) already in drafting — resolve them first`);
  return problems;
}

/** Wraps the real client: refuses any call once the running estimate passes the ceiling. */
function withCostCeiling(client: AnthropicClient): { client: AnthropicClient; spent: () => { calls: number; tokens: number; usd: number } } {
  let calls = 0;
  let tokens = 0;
  let usd = 0;
  const wrapped = {
    ...client,
    async complete(params: Parameters<AnthropicClient["complete"]>[0]) {
      if (usd + EST_PER_CALL_USD > COST_CEILING_USD) {
        throw new Error(`cost ceiling: $${usd.toFixed(4)} spent, next call would pass $${COST_CEILING_USD}`);
      }
      const result = await client.complete(params);
      calls += 1;
      tokens += result.inputTokens + result.outputTokens;
      usd += result.estCostUsd;
      return result;
    },
  } as AnthropicClient;
  return { client: wrapped, spent: () => ({ calls, tokens, usd }) };
}

async function main(): Promise<void> {
  const targets = await loadTargets();
  const writer = await settings.getActiveSetting("writer_prompt_email");
  const footer = await settings.getActiveSetting("compliance_footer");
  console.log(`=== redraft-drafts ${apply ? "--apply" : "(dry run)"} · writer_prompt_email v${writer.version} · compliance_footer v${footer.version} ===`);
  for (const t of targets) {
    console.log(
      `${t.leadId}  ${t.company.padEnd(36).slice(0, 36)}  lead=${t.state.padEnd(16)} touch=${t.touchId} ${t.touchStatus} pv=${t.promptVersion} signs_itself=${t.signOff ? JSON.stringify(t.signOff) : "no"}`,
    );
  }
  const n = targets.length;
  console.log(
    `\nAnthropic estimate: ${n} calls × ≈$${EST_PER_CALL_USD} = ≈$${(n * EST_PER_CALL_USD).toFixed(3)} ` +
      `(one retry each ≈$${(2 * n * EST_PER_CALL_USD).toFixed(3)}); hard ceiling $${COST_CEILING_USD.toFixed(2)}.`,
  );
  console.log(`Telegram: ${n} approval cards to TELEGRAM_ALLOWED_USER_IDS (${(process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").filter(Boolean).length} id).`);

  const problems = await preconditions(targets);
  if (problems.length) {
    console.error(`\nREFUSED:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  if (!apply) {
    console.log("\nDry run: nothing written. Re-run with --apply after operator approval.");
    return;
  }

  for (const t of targets) {
    const { data: killed, error } = await db
      .from("touches")
      .update({ status: "killed" })
      .eq("id", t.touchId)
      .eq("status", t.touchStatus)
      .select("id");
    if (error) throw new Error(`kill touch ${t.touchId}: ${error.message}`);
    if ((killed ?? []).length !== 1) throw new Error(`touch ${t.touchId} changed status underneath us — stopping`);
    await state.transition(t.leadId, t.state, "drafting", "redraft_requested", {
      old_touch_id: t.touchId,
      old_touch_status: t.touchStatus,
      old_prompt_version: t.promptVersion,
      reason: "writer_prompt_email v8 sign-off rule (Session 13)",
    });
    console.log(`KILLED touch ${t.touchId} (${t.touchStatus}) · lead ${t.leadId} ${t.state} → drafting`);
  }

  const ceiling = withCostCeiling(createAnthropicClient());
  const summary = await runDraftStage(
    {
      db: raw,
      anthropic: ceiling.client,
      telegram: createTelegramClient(),
      getActiveSetting: settings.getActiveSetting,
      transition: state.transition,
    },
    { leadIds: targets.map((t) => t.leadId), limit: n },
  );

  console.log("\n--- results ---");
  for (const t of targets) {
    const { data: lead } = await db.from("leads").select("state").eq("id", t.leadId).single();
    const { data: fresh } = await db
      .from("touches")
      .select("id, status, subject, draft_body, prompt_version")
      .eq("lead_id", t.leadId)
      .eq("direction", "outbound")
      .eq("status", "pending_approval")
      .order("created_at", { ascending: false })
      .limit(1);
    const touch = fresh?.[0];
    const body = touch?.draft_body ?? "";
    console.log(
      `${t.company.slice(0, 36).padEnd(36)} lead=${lead?.state} touch=${touch?.id ?? "NONE"} pv=${touch?.prompt_version ?? "-"} ` +
        `words_incl_footer=${touch ? wordCount(body) : "-"} signs_itself=${touch ? (findSignOff(body) ? "YES" : "no") : "-"} subject=${JSON.stringify(touch?.subject ?? null)}`,
    );
  }
  const spent = ceiling.spent();
  console.log(`\nAnthropic: ${spent.calls} call(s), ${spent.tokens} tokens, $${spent.usd.toFixed(5)} (stage summary: ${JSON.stringify({ drafted: summary.drafted, failed: summary.failed, parked_generic: summary.parked_generic })})`);
}

main().catch((error: unknown) => {
  console.error("redraft-drafts FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
