const TELEGRAM_API_BASE = "https://api.telegram.org";

import {
  formatApprovalMessageHtml,
  formatApprovalMessagePlain,
  type ApprovalCompanyContext,
  type ApprovalLeadContext,
  type ApprovalQualificationContext,
  type ApprovalTouchRow,
} from "./telegram-approval";

type TouchRow = ApprovalTouchRow;
type LeadContext = ApprovalLeadContext;
type QualificationContext = ApprovalQualificationContext;
type CompanyContext = ApprovalCompanyContext;

export type TelegramInlineButton = {
  text: string;
  callback_data: string;
};

export type TelegramSendMessageResult = {
  ok: boolean;
  result?: {
    message_id: number;
    chat: { id: number };
  };
  description?: string;
};

export type TelegramClient = ReturnType<typeof createTelegramClient>;

function requireBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }
  return token;
}

export function parseAllowedUserIds(): Set<number> {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "";
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
    .filter((id) => Number.isFinite(id));
  return new Set(ids);
}

export function requireWebhookSecret(): string {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("Missing TELEGRAM_WEBHOOK_SECRET");
  }
  return secret;
}

export type TelegramSendResult = {
  sent: number;
  failed: { userId: number; error: string }[];
};

async function telegramRequest<T>(
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const token = requireBotToken();
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = (await response.json()) as T & {
    ok?: boolean;
    description?: string;
  };

  if (!response.ok || payload.ok === false) {
    const description =
      typeof payload.description === "string"
        ? payload.description
        : response.statusText;
    throw new Error(`Telegram ${method} failed: ${description}`);
  }

  return payload;
}

function approvalButtons(touchId: string): TelegramInlineButton[][] {
  return [
    [
      { text: "✅ Send", callback_data: `approve:${touchId}` },
      { text: "✏️ Edit", callback_data: `edit:${touchId}` },
      { text: "❌ Kill", callback_data: `kill:${touchId}` },
      { text: "💤 Snooze", callback_data: `snooze:${touchId}` },
    ],
  ];
}

export function createTelegramClient() {
  async function sendMessage(
    chatId: number | string,
    text: string,
    options?: {
      replyMarkup?: TelegramInlineButton[][];
      replyToMessageId?: number;
      parseMode?: "HTML";
    },
  ): Promise<number> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };

    if (options?.parseMode) {
      payload.parse_mode = options.parseMode;
    }

    if (options?.replyMarkup) {
      payload.reply_markup = { inline_keyboard: options.replyMarkup };
    }
    if (options?.replyToMessageId) {
      payload.reply_to_message_id = options.replyToMessageId;
    }

    const result = await telegramRequest<TelegramSendMessageResult>(
      "sendMessage",
      payload,
    );
    return result.result?.message_id ?? 0;
  }

  async function editMessage(
    chatId: number | string,
    messageId: number,
    text: string,
    options?: { parseMode?: "HTML" },
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (options?.parseMode) {
      payload.parse_mode = options.parseMode;
    }
    await telegramRequest("editMessageText", payload);
  }

  async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await telegramRequest("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async function sendApproval(
    touch: TouchRow,
    lead: LeadContext,
    qualification: QualificationContext,
    company: CompanyContext,
  ): Promise<TelegramSendResult> {
    const allowed = parseAllowedUserIds();
    if (allowed.size === 0) {
      throw new Error("TELEGRAM_ALLOWED_USER_IDS is empty");
    }

    const text = formatApprovalMessageHtml(touch, lead, qualification, company);
    const buttons = approvalButtons(touch.id);
    const failed: { userId: number; error: string }[] = [];
    let sent = 0;

    for (const userId of allowed) {
      try {
        await sendMessage(userId, text, {
          replyMarkup: buttons,
          parseMode: "HTML",
        });
        sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ userId, error: message });
        if (message.toLowerCase().includes("chat not found")) {
          console.warn(
            `[telegram] chat not found for user_id=${userId} (chat_id must match; operator must /start the bot first)`,
          );
        } else {
          console.warn(`[telegram] send failed for user_id=${userId}: ${message}`);
        }
      }
    }

    return { sent, failed };
  }

  async function sendAlert(text: string): Promise<void> {
    const allowed = parseAllowedUserIds();
    await Promise.all([...allowed].map((userId) => sendMessage(userId, text)));
  }

  async function getUpdates(params: {
    offset?: number;
    timeout?: number;
  }): Promise<unknown[]> {
    const result = await telegramRequest<{ ok: boolean; result: unknown[] }>(
      "getUpdates",
      {
        offset: params.offset,
        timeout: params.timeout ?? 30,
        allowed_updates: ["message", "callback_query"],
      },
    );
    return result.result ?? [];
  }

  async function deleteWebhook(): Promise<void> {
    await telegramRequest("deleteWebhook", { drop_pending_updates: false });
  }

  return {
    sendMessage,
    editMessage,
    answerCallback,
    sendApproval,
    sendAlert,
    getUpdates,
    deleteWebhook,
    formatApprovalMessageHtml,
    formatApprovalMessagePlain,
    approvalButtons,
  };
}
