import { db } from "@/lib/db";
import { createTelegramClient } from "@/lib/integrations/telegram";
import { getActiveSetting, writeNewVersion } from "@/lib/settings";
import { transition } from "@/lib/state";
import { handleTelegramWebhook } from "@/lib/telegram/handler";

// Telegram bot webhook. The secret check (constant-time), the 500/401 rules
// and dispatch live in lib/telegram/handler.ts; this file only wires deps.
export async function POST(req: Request): Promise<Response> {
  return handleTelegramWebhook(req, {
    secret: process.env.TELEGRAM_WEBHOOK_SECRET,
    handlerDeps: () => ({
      db,
      telegram: createTelegramClient(),
      transition,
      getActiveSetting,
      writeNewVersion,
    }),
  });
}
