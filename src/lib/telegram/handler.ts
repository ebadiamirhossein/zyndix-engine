import type { SupabaseClient } from "@supabase/supabase-js";

import type { TelegramClient } from "@/lib/integrations/telegram";
import { parseAllowedUserIds } from "@/lib/integrations/telegram";
import { createStateStore } from "@/lib/state/core";
import type { Database, Json } from "@/types/database";

export type TelegramHandlerDeps = {
  db: SupabaseClient<Database>;
  telegram: TelegramClient;
  transition: ReturnType<typeof createStateStore>["transition"];
  getActiveSetting: (key: string) => Promise<{ version: number; value: unknown }>;
  writeNewVersion: (
    key: string,
    value: unknown,
    changedBy: string,
    changeNote: string,
  ) => Promise<unknown>;
};

type TelegramUser = { id: number; username?: string };
type TelegramChat = { id: number };

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: { message_id: number; chat: TelegramChat; text?: string };
  data?: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  reply_to_message?: { message_id: number; text?: string };
};

export type TelegramUpdate = {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
};

type PendingEditDetail = {
  telegram_user_id: number;
  touch_id: string;
  prompt_message_id?: number;
  resolved?: boolean;
};

function isAllowedUser(userId: number): boolean {
  return parseAllowedUserIds().has(userId);
}

function logRejected(userId: number, reason: string): void {
  console.warn(`[telegram] rejected user ${userId}: ${reason}`);
}

export async function storeWebhookEvent(
  db: SupabaseClient<Database>,
  update: TelegramUpdate,
): Promise<{ stored: boolean; eventId?: string }> {
  const externalId = String(update.update_id);
  const { data: existing } = await db
    .from("webhook_events")
    .select("id")
    .eq("provider", "telegram")
    .eq("external_id", externalId)
    .maybeSingle();

  if (existing?.id) {
    return { stored: false, eventId: existing.id };
  }

  const eventType = update.callback_query
    ? "callback_query"
    : update.message
      ? "message"
      : "unknown";

  const { data, error } = await db
    .from("webhook_events")
    .insert({
      provider: "telegram",
      external_id: externalId,
      event_type: eventType,
      payload: update as unknown as Json,
      processed: false,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to store webhook event: ${error.message}`);
  }

  return { stored: true, eventId: data?.id };
}

async function markWebhookProcessed(
  db: SupabaseClient<Database>,
  eventId: string | undefined,
): Promise<void> {
  if (!eventId) return;
  await db
    .from("webhook_events")
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq("id", eventId);
}

async function getTouch(
  db: SupabaseClient<Database>,
  touchId: string,
): Promise<{
  id: string;
  lead_id: string | null;
  status: string | null;
  subject: string | null;
  draft_body: string | null;
  body: string | null;
} | null> {
  const { data } = await db
    .from("touches")
    .select("id, lead_id, status, subject, draft_body, body")
    .eq("id", touchId)
    .maybeSingle();
  return data;
}

async function getLeadState(
  db: SupabaseClient<Database>,
  leadId: string,
): Promise<string | null> {
  const { data } = await db
    .from("leads")
    .select("state")
    .eq("id", leadId)
    .maybeSingle();
  return data?.state ?? null;
}

async function setPendingEdit(
  db: SupabaseClient<Database>,
  leadId: string,
  userId: number,
  touchId: string,
  promptMessageId?: number,
): Promise<void> {
  await db.from("lead_events").insert({
    lead_id: leadId,
    event: "telegram_edit_pending",
    detail: {
      telegram_user_id: userId,
      touch_id: touchId,
      prompt_message_id: promptMessageId,
      resolved: false,
    } satisfies PendingEditDetail as Json,
  });
}

async function getPendingEdit(
  db: SupabaseClient<Database>,
  userId: number,
): Promise<{ touchId: string; leadId: string; eventId: string } | null> {
  const { data } = await db
    .from("lead_events")
    .select("id, lead_id, detail")
    .eq("event", "telegram_edit_pending")
    .order("created_at", { ascending: false })
    .limit(30);

  for (const row of data ?? []) {
    const detail = row.detail as PendingEditDetail | null;
    if (
      detail &&
      detail.telegram_user_id === userId &&
      !detail.resolved &&
      detail.touch_id &&
      row.lead_id
    ) {
      return {
        touchId: detail.touch_id,
        leadId: row.lead_id,
        eventId: row.id,
      };
    }
  }
  return null;
}

async function resolvePendingEdit(
  db: SupabaseClient<Database>,
  eventId: string,
): Promise<void> {
  const { data } = await db
    .from("lead_events")
    .select("detail")
    .eq("id", eventId)
    .maybeSingle();

  if (!data?.detail || typeof data.detail !== "object") return;

  const detail = {
    ...(data.detail as Record<string, unknown>),
    resolved: true,
  };

  await db
    .from("lead_events")
    .update({ detail: detail as Json })
    .eq("id", eventId);
}

async function handleApprove(
  deps: TelegramHandlerDeps,
  touchId: string,
  chatId: number,
  messageId: number,
  originalText?: string,
): Promise<void> {
  const touch = await getTouch(deps.db, touchId);
  if (!touch?.lead_id || !touch.draft_body) {
    await deps.telegram.sendMessage(chatId, "Touch not found or missing draft.");
    return;
  }

  const leadState = await getLeadState(deps.db, touch.lead_id);
  if (leadState !== "pending_approval") {
    await deps.telegram.sendMessage(
      chatId,
      `Lead is in state ${leadState ?? "unknown"}, not pending_approval.`,
    );
    return;
  }

  await deps.db
    .from("touches")
    .update({ body: touch.draft_body, status: "approved" })
    .eq("id", touchId);

  await deps.transition(touch.lead_id, "pending_approval", "approved", "approved", {
    touch_id: touchId,
    source: "telegram",
  });

  const suffix = "\n\n✅ APPROVED";
  if (originalText) {
    await deps.telegram.editMessage(
      chatId,
      messageId,
      `${originalText}${suffix}`,
      { parseMode: "HTML" },
    );
  } else {
    await deps.telegram.sendMessage(chatId, `Touch ${touchId}${suffix}`);
  }
}

async function handleEditPrompt(
  deps: TelegramHandlerDeps,
  touchId: string,
  userId: number,
  chatId: number,
  messageId: number,
  originalText?: string,
): Promise<void> {
  const touch = await getTouch(deps.db, touchId);
  if (!touch?.lead_id) {
    await deps.telegram.sendMessage(chatId, "Touch not found.");
    return;
  }

  const promptId = await deps.telegram.sendMessage(
    chatId,
    "✏️ Reply to this message with the new email body (subject stays the same).",
  );

  await setPendingEdit(deps.db, touch.lead_id, userId, touchId, promptId);

  if (originalText) {
    await deps.telegram.editMessage(
      chatId,
      messageId,
      `${originalText}\n\n✏️ Waiting for your edited body…`,
      { parseMode: "HTML" },
    );
  }
}

async function handleEditedBody(
  deps: TelegramHandlerDeps,
  userId: number,
  chatId: number,
  newBody: string,
): Promise<void> {
  const pending = await getPendingEdit(deps.db, userId);
  if (!pending) {
    return;
  }

  const touch = await getTouch(deps.db, pending.touchId);
  if (!touch?.draft_body) {
    await deps.telegram.sendMessage(chatId, "Original draft missing — cannot apply edit.");
    return;
  }

  const leadState = await getLeadState(deps.db, pending.leadId);
  if (leadState !== "pending_approval") {
    await deps.telegram.sendMessage(
      chatId,
      `Lead is in state ${leadState ?? "unknown"}, not pending_approval.`,
    );
    return;
  }

  await deps.db
    .from("touches")
    .update({ body: newBody.trim(), status: "approved" })
    .eq("id", pending.touchId);

  await deps.transition(pending.leadId, "pending_approval", "approved", "edited", {
    touch_id: pending.touchId,
    source: "telegram",
  });

  await resolvePendingEdit(deps.db, pending.eventId);

  await deps.telegram.sendMessage(
    chatId,
    `✏️ EDITED — touch ${pending.touchId} approved with your edits.`,
  );
}

async function handleKill(
  deps: TelegramHandlerDeps,
  touchId: string,
  chatId: number,
  messageId: number,
  originalText?: string,
): Promise<void> {
  const touch = await getTouch(deps.db, touchId);
  if (!touch?.lead_id) {
    await deps.telegram.sendMessage(chatId, "Touch not found.");
    return;
  }

  await deps.db.from("touches").update({ status: "killed" }).eq("id", touchId);

  const leadState = await getLeadState(deps.db, touch.lead_id);
  if (leadState === "pending_approval") {
    await deps.transition(touch.lead_id, "pending_approval", "parked", "killed_by_operator", {
      touch_id: touchId,
      source: "telegram",
    });
  }

  const suffix = "\n\n❌ KILLED";
  if (originalText) {
    await deps.telegram.editMessage(
      chatId,
      messageId,
      `${originalText}${suffix}`,
      { parseMode: "HTML" },
    );
  } else {
    await deps.telegram.sendMessage(chatId, `Touch ${touchId}${suffix}`);
  }
}

async function handleSnooze(
  deps: TelegramHandlerDeps,
  touchId: string,
  chatId: number,
  messageId: number,
  originalText?: string,
): Promise<void> {
  const touch = await getTouch(deps.db, touchId);
  if (!touch?.lead_id) {
    await deps.telegram.sendMessage(chatId, "Touch not found.");
    return;
  }

  const snoozeUntil = new Date();
  snoozeUntil.setDate(snoozeUntil.getDate() + 7);

  await deps.db
    .from("leads")
    .update({ next_action_at: snoozeUntil.toISOString() })
    .eq("id", touch.lead_id);

  await deps.db.from("lead_events").insert({
    lead_id: touch.lead_id,
    event: "snoozed",
    detail: {
      touch_id: touchId,
      until: snoozeUntil.toISOString(),
      source: "telegram",
    } as Json,
  });

  const suffix = "\n\n💤 SNOOZED (7 days)";
  if (originalText) {
    await deps.telegram.editMessage(
      chatId,
      messageId,
      `${originalText}${suffix}`,
      { parseMode: "HTML" },
    );
  } else {
    await deps.telegram.sendMessage(chatId, `Touch ${touchId}${suffix}`);
  }
}

async function handleStats(deps: TelegramHandlerDeps, chatId: number): Promise<void> {
  const states = [
    "sourced",
    "enriching",
    "qualifying",
    "qualified",
    "verifying",
    "drafting",
    "pending_approval",
    "approved",
    "queued",
    "sent",
    "replied",
    "parked",
    "manual_hold",
  ] as const;

  const lines: string[] = ["📊 Pipeline counts"];
  for (const state of states) {
    const { count } = await deps.db
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("state", state);
    if ((count ?? 0) > 0) {
      lines.push(`${state}: ${count}`);
    }
  }

  await deps.telegram.sendMessage(chatId, lines.join("\n"));
}

async function handleLead(
  deps: TelegramHandlerDeps,
  chatId: number,
  leadId: string,
): Promise<void> {
  const { data: lead } = await deps.db
    .from("leads")
    .select(
      "id, first_name, last_name, title, email, email_status, state, next_action_at, companies(name, domain)",
    )
    .eq("id", leadId)
    .maybeSingle();

  if (!lead) {
    await deps.telegram.sendMessage(chatId, `Lead not found: ${leadId}`);
    return;
  }

  const { data: events } = await deps.db
    .from("lead_events")
    .select("event, detail, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(8);

  const company = lead.companies as { name: string; domain: string | null } | null;
  const lines = [
    `Lead ${lead.id}`,
    `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim(),
    lead.title ?? "",
    company ? `${company.name} (${company.domain ?? ""})` : "",
    `state: ${lead.state}`,
    `email: ${lead.email ?? "—"} (${lead.email_status ?? "—"})`,
    lead.next_action_at ? `next_action_at: ${lead.next_action_at}` : "",
    "",
    "Recent events:",
  ];

  for (const event of events ?? []) {
    lines.push(`• ${event.created_at} — ${event.event}`);
  }

  await deps.telegram.sendMessage(chatId, lines.filter(Boolean).join("\n"));
}

async function setEnginePaused(
  deps: TelegramHandlerDeps,
  paused: boolean,
  changedBy: string,
): Promise<void> {
  await deps.writeNewVersion(
    "engine_paused",
    paused ? "true" : "false",
    changedBy,
    paused ? "paused via /pause" : "resumed via /resume",
  );
}

async function handleCommand(
  deps: TelegramHandlerDeps,
  message: TelegramMessage,
): Promise<boolean> {
  const text = message.text?.trim() ?? "";
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!userId || !isAllowedUser(userId)) {
    if (userId) logRejected(userId, "command from non-whitelisted user");
    return true;
  }

  if (text === "/stats") {
    await handleStats(deps, chatId);
    return true;
  }

  if (text.startsWith("/lead ")) {
    const leadId = text.slice("/lead ".length).trim();
    await handleLead(deps, chatId, leadId);
    return true;
  }

  if (text === "/pause") {
    await setEnginePaused(deps, true, String(userId));
    await deps.telegram.sendMessage(chatId, "⏸ Engine paused.");
    return true;
  }

  if (text === "/resume") {
    await setEnginePaused(deps, false, String(userId));
    await deps.telegram.sendMessage(chatId, "▶️ Engine resumed.");
    return true;
  }

  return false;
}

async function handleCallback(
  deps: TelegramHandlerDeps,
  callback: TelegramCallbackQuery,
): Promise<void> {
  const userId = callback.from.id;
  if (!isAllowedUser(userId)) {
    logRejected(userId, "callback from non-whitelisted user");
    await deps.telegram.answerCallback(callback.id, "Unauthorized");
    return;
  }

  const data = callback.data ?? "";
  const [action, touchId] = data.split(":");
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;
  const originalText = callback.message?.text;

  if (!touchId || !chatId || !messageId) {
    await deps.telegram.answerCallback(callback.id, "Invalid callback");
    return;
  }

  switch (action) {
    case "approve":
      await handleApprove(deps, touchId, chatId, messageId, originalText);
      await deps.telegram.answerCallback(callback.id, "Approved");
      break;
    case "edit":
      await handleEditPrompt(
        deps,
        touchId,
        userId,
        chatId,
        messageId,
        originalText,
      );
      await deps.telegram.answerCallback(callback.id, "Send edited body");
      break;
    case "kill":
      await handleKill(deps, touchId, chatId, messageId, originalText);
      await deps.telegram.answerCallback(callback.id, "Killed");
      break;
    case "snooze":
      await handleSnooze(deps, touchId, chatId, messageId, originalText);
      await deps.telegram.answerCallback(callback.id, "Snoozed 7d");
      break;
    default:
      await deps.telegram.answerCallback(callback.id, "Unknown action");
  }
}

export async function processTelegramUpdate(
  deps: TelegramHandlerDeps,
  update: TelegramUpdate,
  options?: { skipStore?: boolean; eventId?: string },
): Promise<{ processed: boolean; rejected?: boolean }> {
  const { stored, eventId } = options?.skipStore
    ? { stored: true, eventId: options.eventId }
    : await storeWebhookEvent(deps.db, update);

  if (!stored) {
    return { processed: false };
  }

  try {
    if (update.callback_query) {
      const userId = update.callback_query.from.id;
      if (!isAllowedUser(userId)) {
        logRejected(userId, "callback_query from non-whitelisted user");
        await markWebhookProcessed(deps.db, eventId);
        return { processed: true, rejected: true };
      }
      await handleCallback(deps, update.callback_query);
    } else if (update.message) {
      const userId = update.message.from?.id;
      if (userId && !isAllowedUser(userId)) {
        logRejected(userId, "message from non-whitelisted user");
        await markWebhookProcessed(deps.db, eventId);
        return { processed: true, rejected: true };
      }

      const handled = await handleCommand(deps, update.message);
      if (!handled && update.message.text && userId) {
        const pending = await getPendingEdit(deps.db, userId);
        if (pending && !update.message.text.startsWith("/")) {
          await handleEditedBody(
            deps,
            userId,
            update.message.chat.id,
            update.message.text,
          );
        }
      }
    }

    await markWebhookProcessed(deps.db, eventId);
    return { processed: true };
  } catch (error) {
    console.error("[telegram] handler error:", error);
    throw error;
  }
}
