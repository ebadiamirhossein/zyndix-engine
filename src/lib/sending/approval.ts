import { createHash } from "node:crypto";

// Approval binding (09 §U5, brief §8). The approval is bound to the exact
// content and recipient: the hash covers the canonical snapshot below, stored
// on the touch at approval time and recomputed by preflight immediately before
// every send. Any difference is `stale_approval`.

export type ApprovalSnapshot = {
  touch_id: string;
  lead_id: string;
  step_no: number;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
  prompt_version: number | null;
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
  };
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
