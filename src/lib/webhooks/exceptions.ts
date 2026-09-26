import type { SupabaseClient } from "@supabase/supabase-js";

import type { Json } from "@/types/database";
import type { DatabaseWithWebhooks } from "@/types/database-extensions";

// The exceptions queue (09 §U6, 0009b). Anything the engine cannot attribute
// or cannot finish safely lands here; escalated rows also alert the operator.
// Shared by the webhook processor, the reconcile jobs, the send stage and the
// sequence stop path (lib/sending/stop.ts). Its own module so that stop.ts and
// webhooks/instantly.ts can both use it without importing each other.

/** The provider an exception is attributed to (Wave 1: Calendly, research, classify join Instantly). */
export type ExceptionProvider = "instantly" | "calendly" | "apify" | "anthropic" | "engine";

const PROVIDER_LABEL: Record<ExceptionProvider, string> = {
  instantly: "Instantly",
  calendly: "Calendly",
  apify: "Apify",
  anthropic: "Classifier",
  engine: "Engine",
};

export type ExceptionKind =
  | "unmatched_recipient"
  | "foreign_campaign"
  | "stop_failed"
  | "invalid_payload"
  | "unexpected_state"
  // Raised by the reconcile job (src/lib/reconcile/core.ts), not by a delivery.
  | "stop_processing_stale"
  | "reply_poll_truncated"
  // Raised by the send stage (src/lib/stages/send/core.ts): an accepted
  // follow-up whose recipients do not include the lead (Session 14 drill).
  | "reply_misaddressed"
  // 09 §U6c S21 — follow-up tracking, recipient check, stops, reconcile sweep.
  | "sent_step_unknown"
  | "sent_after_stop"
  | "recipient_misaddressed"
  | "recipient_check_unreadable"
  | "stopped_lead_active"
  | "unknown_active_lead"
  // Wave 1 — U8 (Calendly), U7 (classifier), UR (research).
  | "calendly_unmatched_invitee"
  | "booking_unexpected_state"
  | "meeting_reschedule_unlinked"
  | "classify_failed"
  | "research_run_failed";

export class WebhookProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookProcessingError";
  }
}

export type ExceptionDeps = {
  db: SupabaseClient<DatabaseWithWebhooks>;
  alert: (text: string) => Promise<void>;
  now?: () => Date;
};

export async function raiseException(
  deps: ExceptionDeps,
  input: {
    kind: ExceptionKind;
    eventId: string | null;
    leadId?: string;
    detail: Record<string, unknown>;
    escalate?: boolean;
    /** Send the escalation alert. Defaults to `escalate`; false when the caller alerts itself. */
    notify?: boolean;
    /** Defaults to "instantly" (every pre-Wave-1 caller). */
    provider?: ExceptionProvider;
  },
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const provider = input.provider ?? "instantly";
  const { error } = await deps.db.from("exceptions").insert({
    kind: input.kind,
    provider,
    webhook_event_id: input.eventId,
    lead_id: input.leadId ?? null,
    detail: input.detail as Json,
    status: input.escalate ? "escalated" : "open",
    escalated_at: input.escalate ? now : null,
  });
  if (error) throw new WebhookProcessingError(`exception insert: ${error.message}`);
  if (input.notify ?? input.escalate) {
    await deps.alert(`⚠️ ${PROVIDER_LABEL[provider]} ${input.kind}${input.leadId ? ` · lead ${input.leadId}` : ""}\n${JSON.stringify(input.detail).slice(0, 400)}`);
  }
}
