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

const RULE_BLOCK = `\n\nDATA DISCIPLINE (CRITICAL):\n- Absence of data is NOT evidence of absence.\n- If any input field is marked UNAVAILABLE, you know NOTHING about that dimension.\n- You may NEVER cite a failed fetch or UNAVAILABLE input as evidence.\n- You may NEVER conclude a company lacks a tool because we failed to detect it.\n- Only cite what was positively observed.\n` as const;

async function main(): Promise<void> {
  const apply = hasFlag(process.argv.slice(2), "--apply");

  const current = await settings.getActiveSetting("qualifier_prompt");
  const currentPrompt = String(current.value);

  const proposed =
    currentPrompt.includes("DATA DISCIPLINE (CRITICAL):")
      ? currentPrompt
      : `${currentPrompt}${RULE_BLOCK}`;

  console.log("=== Proposed qualifier_prompt (new version) ===\n");
  console.log(proposed);
  console.log("");

  if (!apply) {
    console.log("(dry-run) Add --apply to write new qualifier_prompt version.");
    return;
  }

  const next = await settings.writeNewVersion(
    "qualifier_prompt",
    proposed,
    "amir",
    "forbid inferring absence from failed fetches",
  );

  console.log(`WROTE qualifier_prompt v${next.version} (active=true)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

