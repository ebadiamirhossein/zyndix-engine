import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { TelegramClient } from "@/lib/integrations/telegram";
import { parseAllowedUserIds } from "@/lib/integrations/telegram";
import { escapeTelegramHtml } from "@/lib/integrations/telegram-format";
import { TELEGRAM_TEXT_LIMIT, telegramVisibleLength } from "@/lib/integrations/telegram-approval";
import { findSignOff } from "@/lib/sending/approval";
import { chooseSenderForApproval } from "@/lib/sending/sender";
import { appendComplianceFooter } from "@/lib/settings/compliance";
import { buildSequenceApprovalSnapshot, sequenceApprovalHash } from "@/lib/sending/sequence-approval";
import { claimsStillPresent } from "@/lib/stages/draft/claims";
import { loadClaimContext } from "@/lib/stages/draft/claims-context";
import {
  checkSequenceClaims,
  formatRepeatIssues,
  formatStepViolations,
  stepsRepeatingStepOne,
  type SequenceStepDraft,
} from "@/lib/stages/draft/sequence";
import { createStateStore } from "@/lib/state/core";
import { emailSequenceSchema, sendPolicySchema } from "@/lib/validation/jsonb";
import { claimLedgerSchema } from "@/lib/validation/llm";
import type { Database, Json } from "@/types/database";
import type { DatabaseWithEnrollments, DatabaseWithSending } from "@/types/database-extensions";

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

/**
 * Approves a lead's whole pending email sequence AND binds the approval to
 * its exact content, recipient, sending account and signature (09 §U5;
 * Session 12; 09 §U6c).
 *
 * One approval covers every step. The steps must be exactly the active
 * email_sequence's steps, all pending_approval. The claim guard re-runs on
 * every step at this instant (freshness with each step's offset, template
 * mode for template steps), operator edits included: an edit replaces one
 * step's body, claims whose span is no longer in it are dropped, and anything
 * the edit added is uncovered and refused. One hash over the whole
 * SequenceApprovalSnapshot is written on every touch by approve_email_sequence
 * (0009d), fenced on all of them being pending_approval — all or none.
 */
type BoundStep = { step_no: number; touch_id: string; subject: string; outbound: string };

type BindResult =
  | { ok: true; sender: { identifier: string; signature: string | null }; hash: string; steps: BoundStep[] }
  | { ok: false; message: string };

const SENDER_REFUSAL: Record<string, string> = {
  bound_sender_missing: "the lead's bound sending account no longer exists",
  bound_sender_no_signature: "the lead's bound sending account has no signature configured",
  no_eligible_sender: "no sending account is eligible (health ok, Instantly campaign, signature)",
  follow_up_unbound: "this follow-up's lead has no bound sending account",
};

const approveResultSchema = z.object({ status: z.enum(["approved", "not_pending"]) }).passthrough();

async function pendingSequenceTouches(db: SupabaseClient<Database>, leadId: string) {
  const sendDb = db as unknown as SupabaseClient<DatabaseWithSending>;
  const { data, error } = await sendDb
    .from("touches")
    .select("id, step_no, channel, subject, draft_body, prompt_version, status, claim_ledger")
    .eq("lead_id", leadId)
    .eq("direction", "outbound")
    .eq("status", "pending_approval");
  if (error) throw new Error(`load pending touches for ${leadId}: ${error.message}`);
  return [...(data ?? [])].sort((a, b) => (a.step_no ?? 0) - (b.step_no ?? 0));
}

async function bindSequenceApproval(
  db: SupabaseClient<Database>,
  getSetting: TelegramHandlerDeps["getActiveSetting"],
  leadId: string,
  approvedBy: number,
  edit?: { touchId: string; body: string },
): Promise<BindResult> {
  const sendDb = db as unknown as SupabaseClient<DatabaseWithSending>;
  const { data: lead } = await sendDb.from("leads").select("id, email, send_account_id").eq("id", leadId).maybeSingle();
  if (!lead) return { ok: false, message: "Lead not found — nothing approved." };

  const sequenceSetting = await getSetting("email_sequence");
  const sequence = emailSequenceSchema.parse(sequenceSetting.value);
  const touches = await pendingSequenceTouches(db, leadId);
  const got = touches.map((t) => t.step_no ?? 0);
  const expected = sequence.steps.map((s) => s.step_no);
  if (got.length !== expected.length || got.some((n, i) => n !== expected[i])) {
    return {
      ok: false,
      message: `Not approved: the pending draft is steps [${got.join(",")}], but email_sequence v${sequenceSetting.version} has steps [${expected.join(",")}]. Kill it and redraft.`,
    };
  }
  if (edit && !touches.some((t) => t.id === edit.touchId)) {
    return { ok: false, message: "Not approved: the step you are editing is no longer pending_approval." };
  }

  // 09 §U6c S20 (operator decision): an edit replaces the whole body, footer
  // included. Every step is its own email and must carry the compliance
  // footer, so an edit that dropped it gets it re-appended before the guard
  // and the hash; the APPROVED texts then show it.
  let editedBody = edit?.body;
  if (edit) {
    const footer = String((await getSetting("compliance_footer")).value).trim();
    if (footer && !edit.body.replace(/\r\n/g, "\n").trimEnd().endsWith(footer)) {
      editedBody = appendComplianceFooter(edit.body, footer);
    }
  }

  const firstSubject = touches[0]!.subject ?? "";
  const drafts: SequenceStepDraft[] = [];
  for (const [i, touch] of touches.entries()) {
    const spec = sequence.steps[i]!;
    const body = edit && edit.touchId === touch.id ? editedBody! : (touch.draft_body ?? "");
    const signOff = findSignOff(body);
    if (signOff) {
      return {
        ok: false,
        message: `Not approved: step ${spec.step_no} signs itself ("${signOff}"). The mailbox signature is added at send — edit that step to remove the sign-off, or redraft.`,
      };
    }
    const ledger = claimLedgerSchema.safeParse(touch.claim_ledger);
    if (touch.claim_ledger === null || touch.claim_ledger === undefined || !ledger.success) {
      return {
        ok: false,
        message: `Not approved: step ${spec.step_no} has no valid claim ledger (written before the claim guard). Kill it and redraft.`,
      };
    }
    const subject = spec.step_no === 1 ? firstSubject : "";
    drafts.push({
      step_no: spec.step_no,
      source: spec.source,
      subject: spec.step_no === 1 ? firstSubject : null,
      body,
      claims: claimsStillPresent(ledger.data, subject, body),
    });
  }

  let claimContext;
  try {
    claimContext = await loadClaimContext(db, getSetting, leadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Not approved: the claim guard could not load its evidence (${message}).` };
  }
  const claimCheck = checkSequenceClaims(claimContext, drafts, sequence);
  if (!claimCheck.ok) {
    return {
      ok: false,
      message: ["Not approved — the claim guard refused this sequence:", ...formatStepViolations(claimCheck.failures).map((line) => `• ${line}`)].join("\n"),
    };
  }
  // 09 §U6c S20: re-checked here, on the claims that survive an edit.
  const repeats = stepsRepeatingStepOne(drafts);
  if (repeats.length > 0) {
    return {
      ok: false,
      message: [
        "Not approved: step2_repeats_step1 — a follow-up cites only evidence step 1 already cites. Kill and redraft, or edit that step.",
        ...formatRepeatIssues(repeats).map((line) => `• ${line}`),
      ].join("\n"),
    };
  }

  const policy = sendPolicySchema.parse((await getSetting("send_policy")).value);
  const choice = await chooseSenderForApproval(sendDb, {
    leadSendAccountId: lead.send_account_id,
    step: 1,
    assignable: policy.assignable_senders,
  });
  if (!choice.ok) {
    return { ok: false, message: `Not approved: ${SENDER_REFUSAL[choice.reason] ?? choice.reason}.` };
  }

  const approvedTouches = touches.map((touch, i) => ({
    id: touch.id,
    step_no: touch.step_no,
    channel: touch.channel,
    subject: touch.subject,
    body: drafts[i]!.body,
    prompt_version: touch.prompt_version,
    claim_ledger: drafts[i]!.claims,
  }));
  const snapshot = buildSequenceApprovalSnapshot({
    lead,
    sender: choice.sender,
    sequence: { version: sequenceSetting.version, value: sequence },
    touches: approvedTouches,
  });
  const hash = sequenceApprovalHash(snapshot);

  const rpcDb = db as unknown as SupabaseClient<DatabaseWithEnrollments>;
  const { data, error } = await rpcDb.rpc("approve_email_sequence", {
    p_lead_id: leadId,
    p_steps: approvedTouches.map((t) => ({ touch_id: t.id, body: t.body, claim_ledger: t.claim_ledger })) as unknown as Json,
    p_hash: hash,
    p_snapshot: snapshot as unknown as Json,
    p_send_account_id: choice.sender.id,
    p_approved_by: `telegram:${approvedBy}`,
  });
  if (error) throw new Error(`approve sequence for lead ${leadId}: ${error.message}`);
  const result = approveResultSchema.parse(data);
  if (result.status !== "approved") {
    return { ok: false, message: "The sequence is no longer entirely pending_approval — nothing approved." };
  }
  return {
    ok: true,
    sender: { identifier: choice.sender.identifier ?? "", signature: snapshot.signature },
    hash,
    steps: snapshot.steps.map((step) => ({ step_no: step.step_no, touch_id: step.touch_id, subject: step.subject, outbound: step.body })),
  };
}

/** The final texts of an approved sequence, as HTML messages that each fit Telegram's limit. */
function approvedTextMessages(bound: Extract<BindResult, { ok: true }>, label: string): string[] {
  const head = `${label} · From: ${escapeTelegramHtml(bound.sender.identifier)} · approval ${bound.hash.slice(0, 12)}`;
  const blocks = bound.steps.map((step) =>
    [
      `<b>Step ${step.step_no} final text (with signature)</b> — ${escapeTelegramHtml(step.subject)}`,
      `<pre>${escapeTelegramHtml(step.outbound)}</pre>`,
    ].join("\n"),
  );
  const messages: string[] = [];
  let current = head;
  for (const block of blocks) {
    const next = `${current}\n\n${block}`;
    if (telegramVisibleLength(next) > TELEGRAM_TEXT_LIMIT) {
      messages.push(current);
      current = block;
    } else current = next;
  }
  messages.push(current);
  return messages;
}

/** Marks the card approved (plain text, only if it still fits), then posts the final texts. */
async function reportApproved(
  deps: TelegramHandlerDeps,
  bound: Extract<BindResult, { ok: true }>,
  label: string,
  chatId: number,
  messageId?: number,
  originalText?: string,
): Promise<void> {
  const suffix = `\n\n${label} · all ${bound.steps.length} steps · From: ${bound.sender.identifier}`;
  if (messageId && originalText && originalText.length + suffix.length <= TELEGRAM_TEXT_LIMIT) {
    await deps.telegram.editMessage(chatId, messageId, `${originalText}${suffix}`);
  }
  for (const text of approvedTextMessages(bound, label)) {
    await deps.telegram.sendMessage(chatId, text, { parseMode: "HTML" });
  }
}

async function handleApprove(
  deps: TelegramHandlerDeps,
  touchId: string,
  userId: number,
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

  const bound = await bindSequenceApproval(deps.db, deps.getActiveSetting, touch.lead_id, userId);
  if (!bound.ok) {
    await deps.telegram.sendMessage(chatId, bound.message);
    return;
  }

  await deps.transition(touch.lead_id, "pending_approval", "approved", "approved", {
    touch_id: bound.steps[0]!.touch_id,
    touch_ids: bound.steps.map((s) => s.touch_id),
    approval_hash: bound.hash,
    source: "telegram",
  });

  await reportApproved(deps, bound, "✅ APPROVED", chatId, messageId, originalText);
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
  const { data: stepRow } = await deps.db.from("touches").select("step_no").eq("id", touchId).maybeSingle();
  const stepNo = stepRow?.step_no ?? 1;

  const promptId = await deps.telegram.sendMessage(
    chatId,
    `✏️ Reply to this message with the new body for STEP ${stepNo}${stepNo === 1 ? " (subject stays the same)" : ""}. ` +
      "Sending it approves the whole sequence with that change.",
  );

  await setPendingEdit(deps.db, touch.lead_id, userId, touchId, promptId);

  if (originalText && originalText.length + 40 <= TELEGRAM_TEXT_LIMIT) {
    await deps.telegram.editMessage(chatId, messageId, `${originalText}\n\n✏️ Waiting for your edited step ${stepNo}…`);
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

  const bound = await bindSequenceApproval(deps.db, deps.getActiveSetting, pending.leadId, userId, {
    touchId: pending.touchId,
    body: newBody.trim(),
  });
  if (!bound.ok) {
    await deps.telegram.sendMessage(chatId, `${bound.message} Edit not applied.`);
    return;
  }

  await deps.transition(pending.leadId, "pending_approval", "approved", "edited", {
    touch_id: pending.touchId,
    touch_ids: bound.steps.map((s) => s.touch_id),
    approval_hash: bound.hash,
    source: "telegram",
  });

  await resolvePendingEdit(deps.db, pending.eventId);

  const edited = bound.steps.find((s) => s.touch_id === pending.touchId)?.step_no ?? "?";
  await deps.telegram.sendMessage(chatId, `✏️ EDITED — step ${edited} changed; the sequence is approved with your edit.`);
  await reportApproved(deps, bound, "✅ APPROVED", chatId);
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

  // The whole sequence dies together (09 §U6c): every pending or approved
  // outbound touch of the lead. Sent touches are history and stay as they are.
  await deps.db
    .from("touches")
    .update({ status: "killed" })
    .eq("lead_id", touch.lead_id)
    .eq("direction", "outbound")
    .in("status", ["pending_approval", "approved"]);

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
      await handleApprove(deps, touchId, userId, chatId, messageId, originalText);
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
