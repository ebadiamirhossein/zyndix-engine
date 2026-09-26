/**
 * scripts/update-writer-prompt-v11.ts — 09 §U6c S20 scope addition (b).
 *
 * writer_prompt_email v10 → v11, from the live v10 draft (07 Session 19):
 * step 1 said "they fill out the form" (E1: "rather than a routed form") and
 * added "the next showing"; step 2 repeated step 1's observation and
 * generalised ("usually where buyer interest goes quiet"). v11:
 *   - no claims about visitor/buyer behaviour unless the evidence states it
 *     (and v10's own example sentence, which modelled exactly that, is gone);
 *   - no generic "usually / most / often" statements;
 *   - no detail the evidence lacks; never the opposite of what it says;
 *   - step 2 must cite an evidence item step 1 does not (enforced by the
 *     deterministic `step2_repeats_step1` check at draft and approval).
 *
 * Default is a dry run that prints the changed lines. `--apply` writes v11,
 * only after the operator's OK. Guard: refuses unless the active version is v10,
 * so it cannot clobber a newer edit.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";

const CHANGED_BY = "session-20-u6c";

const BEHAVIOUR_BLOCK = `NO BEHAVIOUR OR GENERIC CLAIMS
- Never describe what their visitors, buyers, sellers, leads or clients do, think or feel
  ("they fill out the form and wait", "buyer interest goes quiet") unless an evidence item states
  it. Describe only what their own site, profile or process shows.
- Never write a general statement about businesses or their industry: no "usually", "most",
  "often", "typically", "many", "tend to", "in this business".
- Never add a detail the evidence does not contain (a next step, an event, a showing, a person).
  If the evidence says something is NOT there ("rather than a routed form"), never describe it as
  being there.`;

function replaceOnce(text: string, from: string, to: string, label: string): string {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`v10 anchor "${label}" found ${count} times, expected 1`);
  return text.replace(from, to);
}

export function buildWriterPromptV11(v10: string): string {
  let p = v10;
  p = replaceOnce(
    p,
    `If you want to convey
urgency, describe the mechanism ("they fill out the form and wait until someone
checks email"), never a fabricated metric.`,
    `If you want to convey
urgency, describe the mechanism their own evidence shows, never a fabricated metric.`,
    "urgency example",
  );
  p = replaceOnce(p, "\nFORBIDDEN\n", `\n${BEHAVIOUR_BLOCK}\n\nFORBIDDEN\n`, "FORBIDDEN");
  p = replaceOnce(
    p,
    `  Take a NEW angle: a different observation or consequence, grounded in the evidence and cited
  like any claim (ideally a different evidence item than step 1's opener).`,
    `  Take a NEW angle: a different observation or consequence, grounded in the evidence and cited
  like any claim. Step 2 MUST cite at least one evidence item (E-id) that step 1 does not cite;
  a step 2 citing only step 1's items is refused.`,
    "step 2 angle",
  );
  return p;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const db = createServiceClient(url, key);
  const settings = createSettingsStore(db);
  const apply = process.argv.includes("--apply");

  const { data: writer, error } = await db
    .from("settings")
    .select("version, value")
    .eq("key", "writer_prompt_email")
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(`read writer_prompt_email: ${error.message}`);
  if (writer?.version !== 10) throw new Error(`writer_prompt_email is v${writer?.version}, expected v10`);

  const v10 = String(writer.value);
  const v11 = buildWriterPromptV11(v10);

  console.log("=== writer_prompt_email v10 → v11 (changed lines) ===");
  const before = v10.split("\n");
  const after = v11.split("\n");
  for (const line of before) if (!after.includes(line)) console.log(`- ${line}`);
  for (const line of after) if (!before.includes(line)) console.log(`+ ${line}`);
  console.log(`\nlength ${v10.length} → ${v11.length} chars`);

  if (!apply) {
    console.log("\n(dry-run) Add --apply to write writer_prompt_email v11.");
    return;
  }
  const w = await settings.writeNewVersion(
    "writer_prompt_email",
    v11,
    CHANGED_BY,
    "U6c S20: no visitor/buyer-behaviour claims unless evidence states them; no generic usually/most/often; no detail the evidence lacks; step 2 must cite an evidence item step 1 does not",
  );
  console.log(`\nWROTE writer_prompt_email v${w.version}`);
}

if (process.argv[1]?.endsWith("update-writer-prompt-v11.ts")) {
  main().catch((error: unknown) => {
    console.error("update-writer-prompt-v11 FAILED:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
