import { createHash } from "node:crypto";

// Approval binding (09 §U5, brief §8). The approval is bound to the exact
// content and recipient: the hash covers the canonical snapshot below, stored
// on the touch at approval time and recomputed by preflight immediately before
// every send. Any difference is `stale_approval`.
//
// Session 12: the snapshot also covers the sending account and its plain-text
// signature, because the signature is part of what the recipient reads. The
// sender is fixed at approval (touches.send_account_id), and the body that
// leaves is exactly composeOutboundBody(body, signature).

export type ApprovalSnapshot = {
  touch_id: string;
  lead_id: string;
  step_no: number;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
  prompt_version: number | null;
  send_account_id: string | null;
  signature: string | null;
};

export function buildApprovalSnapshot(
  touch: {
    id: string;
    step_no: number | null;
    channel: string | null;
    subject: string | null;
    body: string | null;
    prompt_version: number | null;
  },
  lead: { id: string; email: string | null },
  sender: { id: string; signature_text: string | null } | null,
): ApprovalSnapshot {
  return {
    touch_id: touch.id,
    lead_id: lead.id,
    step_no: touch.step_no ?? 1,
    channel: touch.channel ?? "email",
    recipient: (lead.email ?? "").trim().toLowerCase(),
    subject: (touch.subject ?? "").trim(),
    body: touch.body ?? "",
    prompt_version: touch.prompt_version ?? null,
    send_account_id: sender?.id ?? null,
    signature: normalizeSignature(sender?.signature_text),
  };
}

/** Trimmed signature, or null when there is none. */
export function normalizeSignature(signature: string | null | undefined): string | null {
  const s = (signature ?? "").replace(/\r\n/g, "\n").trim();
  return s ? s : null;
}

const OPT_OUT_LINE = /reply stop/i;

/**
 * The plain-text body that actually leaves (Session 12, operator decision):
 * the signature goes immediately BEFORE the compliance footer — the final
 * paragraph when it carries the opt-out line — else at the very end:
 *
 *   <body>\n\n<signature>\n\n<address + "Reply STOP" footer>
 *
 * It depends only on the approved body and the signature, both of which are
 * in the approval hash, so what is hashed is exactly what is sent.
 */
export function composeOutboundBody(body: string, signature: string | null | undefined): string {
  const sig = normalizeSignature(signature);
  const text = body.replace(/\s+$/, "");
  if (!sig) return text;
  const cut = text.lastIndexOf("\n\n");
  const last = cut >= 0 ? text.slice(cut + 2) : "";
  if (cut >= 0 && OPT_OUT_LINE.test(last)) {
    return `${text.slice(0, cut).replace(/\s+$/, "")}\n\n${sig}\n\n${last}`;
  }
  return `${text}\n\n${sig}`;
}

const NAME = "\\p{Lu}[\\p{L}.'’-]*(?:\\s+\\p{Lu}[\\p{L}.'’-]*){0,2}";
// "— Amir" / "-- Amir Ebadi" on a line of its own. A single hyphen is a bullet, not a sign-off.
const SIGN_OFF_LINE = new RegExp(`^[ \\t]*(?:—|–|--)[ \\t]*${NAME}[ \\t]*$`, "mu");
// "Best,\\nAmir" — a valediction line followed by a name-only line.
const VALEDICTION = new RegExp(
  `^[ \\t]*(?:[Bb]est|[Bb]est [Rr]egards|[Kk]ind [Rr]egards|[Rr]egards|[Cc]heers|[Tt]hanks|[Tt]hank you|[Ww]armly|[Ss]incerely),?[ \\t]*\\n[ \\t]*${NAME}[ \\t]*$`,
  "mu",
);

/**
 * A body that still signs itself ("— Amir", "Best,\nAmir") would name the
 * sender twice once the mailbox signature is appended, and may name the wrong
 * person. Approval refuses it; the operator edits or redrafts.
 */
export function findSignOff(body: string): string | null {
  const m = body.match(SIGN_OFF_LINE) ?? body.match(VALEDICTION);
  return m ? m[0].trim() : null;
}

/** JSON with keys sorted at every level, so the hash never depends on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function approvalHash(snapshot: ApprovalSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/** The stable dispatch key for one approved version of a touch. */
export function sendIdempotencyKey(touchId: string, hash: string): string {
  return `send:${touchId}:${hash}`;
}
