// Cold-sender domain guard (09 §U5, brief §10, CLAUDE.md "Sending").
//
// zyndix.com and every subdomain are blocked as cold sender domains. The check
// is normalized (case, surrounding whitespace, trailing dot) and runs against
// an explicit allow-list. There is deliberately NO override parameter, flag or
// settings key: the allow-list is a code constant so that no database row can
// widen it, and the block is evaluated before the allow-list so that adding
// zyndix.com to the list still would not permit it.

/** The root domain whose reputation must never carry cold mail. */
export const BLOCKED_SENDER_ROOT = "zyndix.com";

/** The purchased cold-sending domains (STEP-11-RUNBOOK §A.1). */
export const ALLOWED_SENDER_DOMAINS: readonly string[] = ["zyndixhq.com", "getzyndix.com"];

export type SenderDomainVerdict =
  | { ok: true; domain: string }
  | { ok: false; reason: "blocked_sender_domain" | "sender_not_allowed"; domain: string };

/** Lowercase, trim, strip trailing dots. Returns "" for nothing usable. */
export function normalizeDomain(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\.+$/, "");
}

/** The domain part of an address (after the last "@"), normalized. */
export function domainOfAddress(address: string | null | undefined): string {
  const trimmed = (address ?? "").trim();
  const at = trimmed.lastIndexOf("@");
  return normalizeDomain(at >= 0 ? trimmed.slice(at + 1) : trimmed);
}

export function isBlockedSenderDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  return d === BLOCKED_SENDER_ROOT || d.endsWith(`.${BLOCKED_SENDER_ROOT}`);
}

/**
 * Accepts a bare domain or a full sender address. Blocked beats allowed;
 * anything not exactly on the allow-list (subdomains included) is refused.
 */
export function checkSenderDomain(senderOrDomain: string | null | undefined): SenderDomainVerdict {
  const raw = senderOrDomain ?? "";
  const domain = raw.includes("@") ? domainOfAddress(raw) : normalizeDomain(raw);
  if (isBlockedSenderDomain(domain)) {
    return { ok: false, reason: "blocked_sender_domain", domain };
  }
  if (!ALLOWED_SENDER_DOMAINS.includes(domain)) {
    return { ok: false, reason: "sender_not_allowed", domain };
  }
  return { ok: true, domain };
}
