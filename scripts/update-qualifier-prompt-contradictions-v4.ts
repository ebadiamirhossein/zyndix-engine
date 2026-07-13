import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const settings = createSettingsStore(db);

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

const RULE_BLOCK = `\n\nCONTRADICTION CHECK (CRITICAL):\nIf two observations contradict each other, DISCARD the contested claim entirely and re-evaluate using only the remaining uncontested evidence. Do not park merely because a contradiction exists. Park only if — after discarding the contested claim — the remaining evidence is too thin to support a specific, checkable hypothesis. A single contradiction in an otherwise strong case is not grounds for rejection.\n` as const;

async function main(): Promise<void> {
  const apply = hasFlag(process.argv.slice(2), "--apply");

  const current = await settings.getActiveSetting("qualifier_prompt");
  const currentPrompt = String(current.value);

  const withoutOldRule = currentPrompt.replace(
    /\n\nCONTRADICTION CHECK \(CRITICAL\):[\s\S]*?\n(?=\n|$)/m,
    "\n",
  );

  const proposed = `${withoutOldRule.trimEnd()}${RULE_BLOCK}`;

  console.log("=== Proposed qualifier_prompt v4 ===\n");
  console.log(proposed);
  console.log("");

  if (!apply) {
    console.log("(dry-run) Add --apply to write qualifier_prompt v4.");
    return;
  }

  const next = await settings.writeNewVersion(
    "qualifier_prompt",
    proposed,
    "amir",
    "contradiction rule: discard contested evidence then re-evaluate",
  );

  console.log(`WROTE qualifier_prompt v${next.version} (active=true)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

