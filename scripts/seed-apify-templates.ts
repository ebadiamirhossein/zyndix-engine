import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import type { Json } from "../src/types/database";
import {
  APIFY_TEMPLATES_SEED,
  APIFY_TEMPLATES_SEED_META,
} from "../src/lib/settings/apify-templates-seed";

const SETTING_KEY = "apify_actor_templates";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);

async function main(): Promise<void> {
  const { data: existing, error: readError } = await db
    .from("settings")
    .select("version")
    .eq("key", SETTING_KEY)
    .eq("active", true)
    .maybeSingle();

  if (readError) {
    console.error(`ERROR ${SETTING_KEY}: ${readError.message}`);
    process.exit(1);
  }

  if (existing) {
    console.log(`SKIP ${SETTING_KEY} (v${existing.version} already active)`);
    return;
  }

  const { error: insertError } = await db.from("settings").insert({
    key: SETTING_KEY,
    version: 1,
    value: APIFY_TEMPLATES_SEED as unknown as Json,
    active: true,
    changed_by: APIFY_TEMPLATES_SEED_META.changed_by,
    change_note: APIFY_TEMPLATES_SEED_META.change_note,
  });

  if (insertError) {
    console.error(`ERROR ${SETTING_KEY}: ${insertError.message}`);
    process.exit(1);
  }

  console.log(`SEED ${SETTING_KEY} v1`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("seed-apify-templates FAILED:", message);
  process.exit(1);
});
