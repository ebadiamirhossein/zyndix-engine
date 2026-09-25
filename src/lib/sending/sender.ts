import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeSignature } from "@/lib/sending/approval";
import { checkSenderDomain } from "@/lib/sending/guard";
import type { DatabaseWithSending } from "@/types/database-extensions";

// Sender assignment at approval (Session 12, operator decision). The
// signature is part of the approval hash, so the sending account must be
// known when the operator approves:
//   - a lead already bound to an account (0008) keeps it — follow-ups and any
//     re-approval of step 1 never rotate mailboxes;
//   - otherwise step 1 takes, among send_policy.assignable_senders (when set),
//     the eligible account with the fewest approved or queued touches waiting
//     on it (ties → identifier order, deterministic).
// Eligible = email kind, health ok, passes the sender-domain guard, has its
// Instantly campaign and a non-empty signature. Daily capacity is a send-time
// question (preflight defers quota_exhausted), so it is not judged here.

export type SenderCandidate = {
  id: string;
  identifier: string | null;
  kind: string | null;
  health: string | null;
  instantly_campaign_id: string | null;
  signature_text: string | null;
};

export type SenderChoice =
  | { ok: true; sender: SenderCandidate; source: "lead_binding" | "least_loaded" }
  | { ok: false; reason: "bound_sender_missing" | "bound_sender_no_signature" | "no_eligible_sender" | "follow_up_unbound" };

export function isEligibleSender(account: SenderCandidate): boolean {
  return (
    account.kind === "email" &&
    account.health === "ok" &&
    Boolean(account.instantly_campaign_id) &&
    Boolean(account.identifier) &&
    checkSenderDomain(account.identifier ?? "").ok &&
    normalizeSignature(account.signature_text) !== null
  );
}

/** Pure: the eligible (and, if listed, assignable) account with the least waiting load; null if none. */
export function pickLeastLoaded(
  accounts: SenderCandidate[],
  load: ReadonlyMap<string, number>,
  assignable?: readonly string[],
): SenderCandidate | null {
  const allowed = assignable ? new Set(assignable.map((a) => a.trim().toLowerCase())) : null;
  const eligible = accounts
    .filter(isEligibleSender)
    .filter((a) => !allowed || allowed.has((a.identifier ?? "").trim().toLowerCase()));
  eligible.sort(
    (a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || (a.identifier ?? "").localeCompare(b.identifier ?? ""),
  );
  return eligible[0] ?? null;
}

const SENDER_COLUMNS = "id, identifier, kind, health, instantly_campaign_id, signature_text";

export async function chooseSenderForApproval(
  db: SupabaseClient<DatabaseWithSending>,
  input: { leadSendAccountId: string | null; step: number; assignable?: readonly string[] },
): Promise<SenderChoice> {
  if (input.leadSendAccountId) {
    const { data, error } = await db.from("send_accounts").select(SENDER_COLUMNS).eq("id", input.leadSendAccountId).maybeSingle();
    if (error) throw new Error(`load bound send_account: ${error.message}`);
    if (!data) return { ok: false, reason: "bound_sender_missing" };
    if (!normalizeSignature(data.signature_text)) return { ok: false, reason: "bound_sender_no_signature" };
    return { ok: true, sender: data, source: "lead_binding" };
  }
  if (input.step > 1) return { ok: false, reason: "follow_up_unbound" };

  const { data: accounts, error } = await db.from("send_accounts").select(SENDER_COLUMNS).order("identifier");
  if (error) throw new Error(`list send_accounts: ${error.message}`);
  const { data: waiting, error: loadError } = await db
    .from("touches")
    .select("send_account_id")
    .in("status", ["approved", "queued"])
    .not("send_account_id", "is", null);
  if (loadError) throw new Error(`sender load: ${loadError.message}`);
  const load = new Map<string, number>();
  for (const t of waiting ?? []) if (t.send_account_id) load.set(t.send_account_id, (load.get(t.send_account_id) ?? 0) + 1);

  const sender = pickLeastLoaded(accounts ?? [], load, input.assignable);
  return sender ? { ok: true, sender, source: "least_loaded" } : { ok: false, reason: "no_eligible_sender" };
}
