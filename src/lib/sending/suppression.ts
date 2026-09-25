import type { SupabaseClient } from "@supabase/supabase-js";

import { domainOfAddress, normalizeDomain } from "@/lib/sending/guard";
import type { Database } from "@/types/database";

// Suppression check immediately before send (09 §U5, brief §7 "again before
// any send"). Normalized: case and surrounding whitespace never let a
// suppressed address through.
//
// Scope (brief §10 "person-level versus company-wide"):
//   - a row WITH an email is person-level: it matches that address only, even
//     if it also carries a domain (the verify stage writes both for an invalid
//     address — that must not suppress the colleagues at the same company);
//   - a row with NO email and a domain is company-wide: it matches every
//     address at that domain and the company's own domain.

export type SuppressionHit = {
  email: boolean;
  domain: boolean;
  rowIds: string[];
};

export function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Escape LIKE wildcards so ilike is an exact, case-insensitive comparison. */
function exactIlike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function checkSuppression(
  db: SupabaseClient<Database>,
  input: { email: string | null; companyDomain: string | null },
): Promise<SuppressionHit> {
  const email = normalizeEmail(input.email);
  const domains = [...new Set([domainOfAddress(email), normalizeDomain(input.companyDomain)].filter(Boolean))];
  const hit: SuppressionHit = { email: false, domain: false, rowIds: [] };

  if (email) {
    const { data, error } = await db
      .from("suppression_list")
      .select("id, email")
      .ilike("email", exactIlike(email))
      .limit(10);
    if (error) throw new Error(`suppression lookup (email) failed: ${error.message}`);
    for (const row of data ?? []) {
      if (normalizeEmail(row.email) === email) {
        hit.email = true;
        hit.rowIds.push(row.id);
      }
    }
  }

  if (domains.length > 0) {
    const { data, error } = await db
      .from("suppression_list")
      .select("id, domain")
      .is("email", null)
      .or(domains.map((d) => `domain.ilike.${exactIlike(d)}`).join(","))
      .limit(10);
    if (error) throw new Error(`suppression lookup (domain) failed: ${error.message}`);
    for (const row of data ?? []) {
      if (domains.includes(normalizeDomain(row.domain))) {
        hit.domain = true;
        hit.rowIds.push(row.id);
      }
    }
  }

  return hit;
}
