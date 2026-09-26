import { z } from "zod";

import type { InstantlyClient } from "@/lib/integrations/instantly";
import type { JobContext } from "@/lib/jobs/registry";
import { ALLOWED_SENDER_DOMAINS, BLOCKED_SENDER_ROOT, domainOfAddress } from "@/lib/sending/guard";
import { loadSender, pauseSender, type StopDeps, stopSequence } from "@/lib/sending/stop";
import { normalizeEmail } from "@/lib/sending/suppression";
import { raiseException } from "@/lib/webhooks/exceptions";
import type { Json } from "@/types/database";
import type { LeadState } from "@/types/enums";

// Post-send recipient check on EVERY email_sent, step 1 included (09 §U6c
// scope 6, Session 17 design rule). Sessions 14 and 16 proved that a send the
// provider "accepted" can be addressed to our own mailbox. So each sent email
// is read back (GET /api/v2/emails/{id}) and passes only when
//
//   To  = exactly [the lead]    and    Cc = Bcc = empty.
//
// Any own address (a send_accounts mailbox, or any zyndix.com / zyndixhq.com /
// getzyndix.com address or subdomain) anywhere, the lead missing, or anyone
// else on it → `recipient_misaddressed`, fail closed: touch failed (the
// capacity stays counted — the email went out), escalated exception + alert,
// lead manual_hold, stopSequence, and the sender paused (campaign first, then
// its other in-flight leads).
//
// Runs as a job (`send.recipient_check`), enqueued by the email_sent webhook
// with a delay: GET /emails lags ~20 s behind the webhook (S18). An email not
// yet readable backs off; still unreadable at the last attempt →
// `recipient_check_unreadable`: escalated, lead held and its sequence stopped,
// but the sender is not paused (unverified is not proven misaddressed).

export const RECIPIENT_CHECK_JOB_TYPE = "send.recipient_check";
/** GET /emails lags ~20 s behind the email_sent webhook (S18); start after a minute. */
export const RECIPIENT_CHECK_DELAY_MS = 60_000;

/** Our own domains: the brand root and both cold-sending domains, subdomains included. */
export const OWN_DOMAINS: readonly string[] = [BLOCKED_SENDER_ROOT, ...ALLOWED_SENDER_DOMAINS];

export const recipientCheckPayloadSchema = z
  .object({
    lead_id: z.string().uuid(),
    touch_id: z.string().uuid(),
    email_id: z.string().min(1),
    step: z.number().int().min(1),
    send_account_id: z.string().uuid().nullable(),
  })
  .strict();
export type RecipientCheckPayload = z.infer<typeof recipientCheckPayloadSchema>;

/** Normalized addresses from a comma-separated list ("a@x.com, Name <b@y.com>"). */
export function addressList(value: string | null | undefined): string[] {
  return (value ?? "").match(/[^\s<>,;"]+@[^\s<>,;"]+/g)?.map((e) => normalizeEmail(e)) ?? [];
}

export function isOwnAddress(address: string, ownAddresses: ReadonlySet<string>): boolean {
  const email = normalizeEmail(address);
  if (ownAddresses.has(email)) return true;
  const domain = domainOfAddress(email);
  return OWN_DOMAINS.some((own) => domain === own || domain.endsWith(`.${own}`));
}

export type RecipientIssue =
  | "own_address_in_to"
  | "own_address_in_cc"
  | "own_address_in_bcc"
  | "lead_not_sole_to"
  | "cc_not_empty"
  | "bcc_not_empty";

export function checkRecipients(input: {
  to: string | null | undefined;
  cc: string | null | undefined;
  bcc: string | null | undefined;
  leadEmail: string | null | undefined;
  ownAddresses: Iterable<string>;
}): { ok: true } | { ok: false; issues: RecipientIssue[] } {
  const own = new Set([...input.ownAddresses].map((a) => normalizeEmail(a)).filter(Boolean));
  const to = addressList(input.to);
  const cc = addressList(input.cc);
  const bcc = addressList(input.bcc);
  const lead = normalizeEmail(input.leadEmail);

  const issues: RecipientIssue[] = [];
  if (to.some((a) => isOwnAddress(a, own))) issues.push("own_address_in_to");
  if (cc.some((a) => isOwnAddress(a, own))) issues.push("own_address_in_cc");
  if (bcc.some((a) => isOwnAddress(a, own))) issues.push("own_address_in_bcc");
  if (!lead || to.length !== 1 || to[0] !== lead) issues.push("lead_not_sole_to");
  if (cc.length > 0) issues.push("cc_not_empty");
  if (bcc.length > 0) issues.push("bcc_not_empty");
  return issues.length ? { ok: false, issues } : { ok: true };
}

export type RecipientCheckDeps = StopDeps & {
  instantly: StopDeps["instantly"] & Pick<InstantlyClient, "getEmail">;
};

export type RecipientCheckOutcome =
  | { kind: "passed" }
  | { kind: "misaddressed"; issues: RecipientIssue[] }
  | { kind: "unreadable"; error: string }
  | { kind: "already_handled" };

export async function runRecipientCheck(
  deps: RecipientCheckDeps,
  job: Pick<JobContext<RecipientCheckPayload>, "payload" | "attempt" | "maxAttempts">,
): Promise<RecipientCheckOutcome> {
  const p = job.payload;
  if (await alreadyRecorded(deps, p)) return { kind: "already_handled" };

  let email;
  try {
    email = await deps.instantly.getEmail(p.email_id);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // Not readable yet (listing lag) or a transient error: back off, unless
    // this was the last attempt — then fail closed without guessing.
    if (job.attempt < job.maxAttempts) throw error;
    await raiseException(deps, {
      kind: "recipient_check_unreadable",
      eventId: null,
      leadId: p.lead_id,
      escalate: true,
      detail: { email_id: p.email_id, step: p.step, touch_id: p.touch_id, attempts: job.attempt, error: text.slice(0, 500) },
    });
    await hold(deps, p.lead_id, "recipient_check_unreadable", { email_id: p.email_id, step: p.step });
    await stopSequence(deps, p.lead_id, "recipient_check_unreadable");
    return { kind: "unreadable", error: text };
  }

  const { data: lead, error: leadError } = await deps.db.from("leads").select("email").eq("id", p.lead_id).maybeSingle();
  if (leadError) throw new Error(`recipient check lead: ${leadError.message}`);
  const { data: accounts, error: accountError } = await deps.db.from("send_accounts").select("identifier");
  if (accountError) throw new Error(`recipient check senders: ${accountError.message}`);
  const ownAddresses = (accounts ?? []).map((a) => a.identifier ?? "").filter(Boolean);

  const verdict = checkRecipients({
    to: email.to_address_email_list,
    cc: email.cc_address_email_list,
    bcc: email.bcc_address_email_list,
    leadEmail: lead?.email,
    ownAddresses,
  });
  const recipients = {
    to: email.to_address_email_list,
    cc: email.cc_address_email_list ?? null,
    bcc: email.bcc_address_email_list ?? null,
  };

  if (verdict.ok) {
    await logEvent(deps, p.lead_id, "recipient_check_passed", { email_id: p.email_id, step: p.step, touch_id: p.touch_id, ...recipients });
    return { kind: "passed" };
  }

  // Fail closed, in the order the plan fixes (09 §U6c scope 6).
  // 1. The touch failed; its capacity stays counted (the email did go out).
  const { error: touchError } = await deps.db.from("touches").update({ status: "failed" }).eq("id", p.touch_id);
  if (touchError) throw new Error(`recipient check touch: ${touchError.message}`);
  // 2. Escalated exception + alert.
  await raiseException(deps, {
    kind: "recipient_misaddressed",
    eventId: null,
    leadId: p.lead_id,
    escalate: true,
    detail: { email_id: p.email_id, step: p.step, touch_id: p.touch_id, issues: verdict.issues, lead_email: lead?.email ?? null, ...recipients },
  });
  // 3. Lead held.
  await hold(deps, p.lead_id, "recipient_misaddressed", { email_id: p.email_id, step: p.step, issues: verdict.issues });
  // 4. Its sequence stopped (the pause below covers a failed stop).
  await stopSequence(deps, p.lead_id, "recipient_misaddressed", { noPause: true });
  // 5. The sender paused: campaign first, then its other in-flight leads.
  const account = p.send_account_id ? await loadSender(deps.db, p.send_account_id) : null;
  if (account) {
    await pauseSender(deps, {
      account,
      reason: `recipient_misaddressed: email ${p.email_id} (step ${p.step}) — ${verdict.issues.join(", ")}`,
      why: `recipient_misaddressed on step ${p.step}: ${verdict.issues.join(", ")}`,
      skipLeadId: p.lead_id,
    });
  }
  return { kind: "misaddressed", issues: verdict.issues };
}

/** A replayed job must not re-raise: the email's verdict is recorded once. */
async function alreadyRecorded(deps: RecipientCheckDeps, p: RecipientCheckPayload): Promise<boolean> {
  const { data: passed, error } = await deps.db
    .from("lead_events")
    .select("id")
    .eq("lead_id", p.lead_id)
    .eq("event", "recipient_check_passed")
    .eq("detail->>email_id", p.email_id)
    .limit(1);
  if (error) throw new Error(`recipient check replay: ${error.message}`);
  if ((passed ?? []).length > 0) return true;
  const { data: failed, error: exError } = await deps.db
    .from("exceptions")
    .select("id")
    .eq("lead_id", p.lead_id)
    .in("kind", ["recipient_misaddressed", "recipient_check_unreadable"])
    .eq("detail->>email_id", p.email_id)
    .limit(1);
  if (exError) throw new Error(`recipient check replay: ${exError.message}`);
  return (failed ?? []).length > 0;
}

async function hold(deps: RecipientCheckDeps, leadId: string, event: string, detail: Record<string, unknown>): Promise<void> {
  const { data, error } = await deps.db.from("leads").select("state").eq("id", leadId).maybeSingle();
  if (error) throw new Error(`recipient check state: ${error.message}`);
  const state = (data?.state as LeadState | undefined) ?? null;
  if (state && state !== "manual_hold" && state !== "suppressed") {
    await deps.transition(leadId, state, "manual_hold", event, detail);
  }
}

async function logEvent(deps: RecipientCheckDeps, leadId: string, event: string, detail: Record<string, unknown>): Promise<void> {
  const { error } = await deps.db.from("lead_events").insert({ lead_id: leadId, event, detail: detail as Json });
  if (error) throw new Error(`lead_event ${event}: ${error.message}`);
}
