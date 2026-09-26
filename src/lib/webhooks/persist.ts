import type { SupabaseClient } from "@supabase/supabase-js";

import type { Json } from "@/types/database";
import type { DatabaseWithWebhooks } from "@/types/database-extensions";

import { WebhookProcessingError } from "./exceptions";

// Persist first (brief §10: "persist them before processing, deduplicate and
// tolerate reordering"). Every provider webhook stores the raw delivery in
// webhook_events before any processing; the unique (provider, external_id)
// index is the dedupe. Extracted from webhooks/instantly.ts in Wave 1 so the
// Calendly route (U8) uses the same path.

export type WebhookDb = SupabaseClient<DatabaseWithWebhooks>;

export type PersistedEvent = { id: string; duplicate: boolean; processed: boolean };

export async function persistEvent(
  db: WebhookDb,
  input: { provider: string; externalId: string; eventType: string; raw: Record<string, unknown> },
): Promise<PersistedEvent> {
  const { data, error } = await db
    .from("webhook_events")
    .insert({
      provider: input.provider,
      external_id: input.externalId,
      event_type: input.eventType,
      payload: input.raw as Json,
      processed: false,
    })
    .select("id")
    .single();
  if (!error && data) return { id: data.id, duplicate: false, processed: false };
  if (error?.code !== "23505") throw new WebhookProcessingError(`persist webhook_event: ${error?.message ?? "no row"}`);

  const { data: existing, error: loadError } = await db
    .from("webhook_events")
    .select("id, processed")
    .eq("provider", input.provider)
    .eq("external_id", input.externalId)
    .single();
  if (loadError || !existing) throw new WebhookProcessingError(`load duplicate webhook_event: ${loadError?.message}`);
  return { id: existing.id, duplicate: true, processed: Boolean(existing.processed) };
}

export async function markProcessed(db: WebhookDb, eventId: string, now: Date): Promise<void> {
  const { error } = await db
    .from("webhook_events")
    .update({ processed: true, processed_at: now.toISOString(), processing_error: null })
    .eq("id", eventId);
  if (error) throw new WebhookProcessingError(`mark processed: ${error.message}`);
}

/** Records why processing failed; the delivery is redelivered and replayed. */
export async function markFailed(db: WebhookDb, eventId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.from("webhook_events").update({ processing_error: message.slice(0, 2000) }).eq("id", eventId);
}
