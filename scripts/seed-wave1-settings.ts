/**
 * scripts/seed-wave1-settings.ts — Wave 1 (09 §U9, §UR, §U7).
 *
 * Seeds v1 of operations_pause, orchestrator_budgets, research_policy and
 * reply_policy from src/lib/settings/seed-content.ts. Each value is validated
 * by its settings schema before anything is written.
 *
 * Default is a dry run: it reads the active rows and prints what it would
 * write. `--apply` writes only the keys that have no active row (it never
 * overwrites an existing version) and is an operator decision. `--only <key>`
 * limits the run to one key.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";
import { SEED_SETTINGS } from "../src/lib/settings/seed-content";

export const WAVE1_KEYS = ["operations_pause", "orchestrator_budgets", "research_policy", "reply_policy"] as const;

const CHANGED_BY = "wave-1-seed";

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  const apply = process.argv.includes("--apply");
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  const keys = WAVE1_KEYS.filter((k) => !only || k === only);
  if (only && keys.length === 0) throw new Error(`--only ${only}: not a Wave 1 key (${WAVE1_KEYS.join(", ")})`);

  const db = createServiceClient(url, key);
  const settings = createSettingsStore(db);

  for (const settingKey of keys) {
    const { data: existing, error } = await db
      .from("settings")
      .select("version")
      .eq("key", settingKey)
      .eq("active", true)
      .maybeSingle();
    if (error) throw new Error(`read ${settingKey}: ${error.message}`);
    if (existing) {
      console.log(`SKIP  ${settingKey} (v${existing.version} already active)`);
      continue;
    }
    const value = SEED_SETTINGS[settingKey];
    console.log(`PLAN  ${settingKey} v1 = ${JSON.stringify(value)}`);
    if (!apply) continue;
    const written = await settings.writeNewVersion(settingKey, value, CHANGED_BY, "Wave 1 v1 seed (09 §U9/§UR/§U7)");
    console.log(`WROTE ${settingKey} v${written.version}`);
  }
  if (!apply) console.log("\n(dry-run) Add --apply to write the PLAN rows.");
}

if (process.argv[1]?.endsWith("seed-wave1-settings.ts")) {
  main().catch((error: unknown) => {
    console.error("seed-wave1-settings FAILED:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
