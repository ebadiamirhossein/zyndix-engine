import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";
import type { ApifyActorTemplates } from "../src/lib/validation/jsonb";

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

async function main(): Promise<void> {
  const apply = hasFlag(process.argv.slice(2), "--apply");

  const current = await settings.getActiveSetting("apify_actor_templates");
  const currentTemplates = current.value as ApifyActorTemplates;

  const proposed: ApifyActorTemplates = {
    ...currentTemplates,
    site: {
      ...currentTemplates.site,
      input: {
        ...currentTemplates.site.input,
        crawlerType: "playwright:adaptive",
      },
    },
  };

  console.log("=== Proposed apify_actor_templates v2 ===\n");
  console.log(JSON.stringify(proposed, null, 2));
  console.log("");

  if (!apply) {
    console.log("(dry-run) Add --apply to write settings v2.");
    return;
  }

  const next = await settings.writeNewVersion(
    "apify_actor_templates",
    proposed,
    "amir",
    'site crawler → playwright: cheerio returns zero pages on JS-rendered sites (Astro/Vercel)',
  );

  console.log(`WROTE apify_actor_templates v${next.version} (active=true)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

