import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import type { Json } from "../src/types/database";
import { SETTING_KEYS } from "../src/lib/settings/core";
import { SEED_META, SEED_SETTINGS } from "../src/lib/settings/seed-content";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);

async function main(): Promise<void> {
  for (const settingKey of SETTING_KEYS) {
    const { data: existing, error: readError } = await db
      .from("settings")
      .select("version")
      .eq("key", settingKey)
      .eq("active", true)
      .maybeSingle();

    if (readError) {
      console.error(`ERROR ${settingKey}: ${readError.message}`);
      process.exit(1);
    }

    if (existing) {
      console.log(`SKIP ${settingKey} (v${existing.version} already active)`);
      continue;
    }

    const value = SEED_SETTINGS[settingKey] as Json;
    const { error: insertError } = await db.from("settings").insert({
      key: settingKey,
      version: 1,
      value,
      active: true,
      changed_by: SEED_META.changed_by,
      change_note: SEED_META.change_note,
    });

    if (insertError) {
      console.error(`ERROR ${settingKey}: ${insertError.message}`);
      process.exit(1);
    }

    console.log(`SEED ${settingKey} v1`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("seed-settings FAILED:", message);
  process.exit(1);
});
