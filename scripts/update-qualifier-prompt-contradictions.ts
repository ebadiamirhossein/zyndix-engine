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

const RULE_BLOCK = `\n\nCONTRADICTION CHECK (CRITICAL):\nBefore finalizing, scan your own evidence list for internal contradictions. If one observation contradicts another (e.g. site copy references a chat widget but the tech scan reports none), you MUST NOT build the hypothesis on the contested claim. Either drop it and build on uncontested evidence, or lower the fit_score and state the conflict in disqualify_reason. Never assert to a prospect something their own website contradicts.\n` as const;

async function main(): Promise<void> {
  const apply = hasFlag(process.argv.slice(2), "--apply");

  const current = await settings.getActiveSetting("qualifier_prompt");
  const currentPrompt = String(current.value);

  const proposed = currentPrompt.includes("CONTRADICTION CHECK (CRITICAL):")
    ? currentPrompt
    : `${currentPrompt}${RULE_BLOCK}`;

  console.log("=== Proposed qualifier_prompt (new version) ===\n");
  console.log(proposed);
  console.log("");

  if (!apply) {
    console.log("(dry-run) Add --apply to write qualifier_prompt v3.");
    return;
  }

  const next = await settings.writeNewVersion(
    "qualifier_prompt",
    proposed,
    "amir",
    "add contradiction scan before finalizing evidence",
  );

  console.log(`WROTE qualifier_prompt v${next.version} (active=true)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

