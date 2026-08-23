import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createTelegramClient } from "../src/lib/integrations/telegram";
import { createSettingsStore } from "../src/lib/settings/core";
import { createStateStore } from "../src/lib/state/core";
import {
  processTelegramUpdate,
  type TelegramUpdate,
} from "../src/lib/telegram/handler";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const state = createStateStore(db);
const settings = createSettingsStore(db);
const telegram = createTelegramClient();

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const testReject = hasFlag(argv, "--test-reject");

  console.log("Deleting webhook (required for getUpdates long-polling)…");
  await telegram.deleteWebhook();
  console.log("Polling Telegram updates. Ctrl+C to stop.\n");

  let offset = 0;

  if (testReject) {
    console.log(
      "Tip: trigger a callback from a non-whitelisted account; it should log a rejection and not change DB state.",
    );
  }

  while (true) {
    const updates = (await telegram.getUpdates({ offset, timeout: 30 })) as TelegramUpdate[];

    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        const result = await processTelegramUpdate(
          {
            db,
            telegram,
            transition: state.transition,
            getActiveSetting: settings.getActiveSetting,
            writeNewVersion: settings.writeNewVersion,
          },
          update,
        );
        console.log(
          `[poll] update ${update.update_id} processed=${result.processed} rejected=${result.rejected ?? false}`,
        );
      } catch (error) {
        console.error(`[poll] update ${update.update_id} failed:`, error);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
