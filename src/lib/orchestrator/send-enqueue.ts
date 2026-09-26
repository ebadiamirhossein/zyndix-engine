import type { SupabaseClient } from "@supabase/supabase-js";

import type { JobQueue } from "@/lib/jobs/queue";
import { isSequenceSnapshot } from "@/lib/sending/sequence-approval";
import { enqueueSend } from "@/lib/stages/send/core";
import type { DatabaseWithSending } from "@/types/database-extensions";

import { isCampaignPaused, type PauseState } from "./pause";

// stage.send_enqueue (09 §U9). Turns sequence-approved leads into `send.email`
// jobs — step 1 ONLY. Steps >= 2 are the Instantly campaign's own steps
// (09 §U6c): the enroll carries them, and runSendJob refuses a step >= 2 with
// followup_engine_send_disabled anyway.
//
// What the Telegram approval leaves behind (approve_email_sequence, 0009d):
// the lead in `approved`, and every step's touch `approved` under ONE
// sequence hash with a `kind: sequence` snapshot and the chosen
// send_account_id. enqueueSend's idempotency key is send:<touch>:<hash>, so
// a lead already enqueued — sent, deferred or held — dedupes onto its first
// job and is never enqueued twice for the same approval.
//
// Skips are an optimisation, not the gate: a paused sender or campaign would
// be refused by preflight (sender_unhealthy / campaign_paused) — skipping it
// here only avoids a job that defers every hour. Preflight stays the gate.

type SendDb = SupabaseClient<DatabaseWithSending>;

export type SendEnqueueDeps = {
  db: SendDb;
  queue: Pick<JobQueue, "enqueue">;
  readPause: () => Promise<PauseState>;
};

export type SendEnqueueSkip =
  | "paused"
  | "no_step1_touch"
  | "ambiguous_step1_touch"
  | "not_sequence_approved"
  | "sender_missing"
  | "sender_paused"
  | "campaign_paused";

export type SendEnqueueSummary = {
  considered: number;
  enqueued: number;
  /** enqueueSend found the job from an earlier tick (idempotency key). */
  already_enqueued: number;
  skipped: Partial<Record<SendEnqueueSkip, number>>;
  enqueued_touch_ids: string[];
};

/** Approved leads read per tick, relative to `limit`: skipped/deduped leads do not use up the limit. */
const SCAN_FACTOR = 10;
const SCAN_MAX = 500;

export async function runSendEnqueueStage(
  deps: SendEnqueueDeps,
  options: {
    limit: number;
    /** Only these leads (scripts and tests; production passes nothing and picks by state). */
    leadIds?: string[];
  },
): Promise<SendEnqueueSummary> {
  const summary: SendEnqueueSummary = { considered: 0, enqueued: 0, already_enqueued: 0, skipped: {}, enqueued_touch_ids: [] };
  const skip = (reason: SendEnqueueSkip) => {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
  };

  const pause = await deps.readPause();
  if (pause.global) {
    skip("paused");
    return summary;
  }

  if (options.leadIds && options.leadIds.length === 0) return summary;

  let query = deps.db
    .from("leads")
    .select("id, send_account_id")
    .eq("state", "approved")
    .order("state_changed_at", { ascending: true })
    .limit(Math.min(SCAN_MAX, options.limit * SCAN_FACTOR));
  if (options.leadIds) query = query.in("id", options.leadIds);
  const { data: leads, error } = await query;
  if (error) throw new Error(`send_enqueue: list approved leads: ${error.message}`);
  if (!leads || leads.length === 0) return summary;

  const { data: touches, error: touchError } = await deps.db
    .from("touches")
    .select("id, lead_id, step_no, status, approval_hash, approval_snapshot, send_account_id")
    .in(
      "lead_id",
      leads.map((l) => l.id),
    )
    .eq("step_no", 1)
    .eq("direction", "outbound")
    .eq("channel", "email")
    .eq("status", "approved");
  if (touchError) throw new Error(`send_enqueue: load step-1 touches: ${touchError.message}`);

  const senderIds = new Set<string>();
  for (const t of touches ?? []) if (t.send_account_id) senderIds.add(t.send_account_id);
  for (const l of leads) if (l.send_account_id) senderIds.add(l.send_account_id);
  const senders = new Map<string, { health: string | null; instantly_campaign_id: string | null }>();
  if (senderIds.size > 0) {
    const { data, error: senderError } = await deps.db
      .from("send_accounts")
      .select("id, health, instantly_campaign_id")
      .in("id", [...senderIds]);
    if (senderError) throw new Error(`send_enqueue: load senders: ${senderError.message}`);
    for (const s of data ?? []) senders.set(s.id, s);
  }

  for (const lead of leads) {
    if (summary.enqueued >= options.limit) break;
    summary.considered += 1;

    const stepOnes = (touches ?? []).filter((t) => t.lead_id === lead.id);
    if (stepOnes.length === 0) {
      skip("no_step1_touch");
      continue;
    }
    if (stepOnes.length > 1) {
      skip("ambiguous_step1_touch");
      continue;
    }
    const touch = stepOnes[0]!;
    // Belt and braces: the query already asks for step 1.
    if (touch.step_no !== 1) continue;
    if (!touch.approval_hash || !isSequenceSnapshot(touch.approval_snapshot)) {
      skip("not_sequence_approved");
      continue;
    }

    // The sender the send stage will use: the touch's own, else the lead's
    // binding. Neither (a pre-Session-12 approval) → the send stage picks one.
    const senderId = touch.send_account_id ?? lead.send_account_id;
    if (senderId) {
      const sender = senders.get(senderId);
      if (!sender) {
        skip("sender_missing");
        continue;
      }
      if (sender.health !== "ok") {
        skip("sender_paused");
        continue;
      }
      if (isCampaignPaused(pause, sender.instantly_campaign_id)) {
        skip("campaign_paused");
        continue;
      }
    }

    const { deduped } = await enqueueSend(deps, { id: touch.id, approval_hash: touch.approval_hash });
    if (deduped) {
      summary.already_enqueued += 1;
    } else {
      summary.enqueued += 1;
      summary.enqueued_touch_ids.push(touch.id);
    }
  }
  return summary;
}
