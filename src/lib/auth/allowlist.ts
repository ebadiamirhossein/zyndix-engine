import { APP_ROLES, type AppRole } from "@/types/enums";

const DEFAULT_ROLE: AppRole = "viewer";

function isAppRole(value: string): value is AppRole {
  return (APP_ROLES as readonly string[]).includes(value);
}

/**
 * Parses DASHBOARD_ALLOWED_EMAILS into email -> role.
 *
 *   DASHBOARD_ALLOWED_EMAILS=amir@zyndix.com:admin,ops@zyndix.com:operator,tmp@zyndix.com
 *
 * A bare email gets `viewer`. An unrecognised role suffix also gets `viewer`
 * rather than being dropped — a typo must not silently grant more than intended,
 * and must not lock the operator out either.
 *
 * Emails are lower-cased; Supabase reports them lower-cased too.
 * Mirrors parseAllowedUserIds() in lib/integrations/telegram.ts.
 */
export function parseAllowedEmails(raw = process.env.DASHBOARD_ALLOWED_EMAILS ?? ""): Map<string, AppRole> {
  const entries = new Map<string, AppRole>();

  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const separator = trimmed.lastIndexOf(":");
    const email = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim().toLowerCase();
    const roleRaw = separator === -1 ? "" : trimmed.slice(separator + 1).trim();

    if (!email.includes("@")) {
      continue;
    }

    entries.set(email, isAppRole(roleRaw) ? roleRaw : DEFAULT_ROLE);
  }

  return entries;
}

/** The role this email should be provisioned with, or null if it may not sign in at all. */
export function allowedRoleFor(
  email: string,
  allowList = parseAllowedEmails(),
): AppRole | null {
  return allowList.get(email.trim().toLowerCase()) ?? null;
}
