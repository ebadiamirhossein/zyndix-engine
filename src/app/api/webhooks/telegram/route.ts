import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { createTelegramClient, requireWebhookSecret } from "@/lib/integrations/telegram";
import { getActiveSetting, writeNewVersion } from "@/lib/settings";
import { transition } from "@/lib/state";
import {
  processTelegramUpdate,
  type TelegramUpdate,
} from "@/lib/telegram/handler";

export async function POST(req: Request): Promise<NextResponse> {
  const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  let expected: string;
  try {
    expected = requireWebhookSecret();
  } catch {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  if (secret !== expected) {
    console.warn("[telegram] webhook rejected: invalid secret");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const telegram = createTelegramClient();
  const result = await processTelegramUpdate(
    {
      db,
      telegram,
      transition,
      getActiveSetting,
      writeNewVersion,
    },
    update,
  );

  return NextResponse.json({
    ok: true,
    processed: result.processed,
    rejected: result.rejected ?? false,
  });
}
