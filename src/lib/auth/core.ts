import type { SupabaseClient } from "@supabase/supabase-js";

import type { DatabaseWithAppUsers } from "@/types/database-extensions";
import { APP_ROLES, type AppRole } from "@/types/enums";

type Db = SupabaseClient<DatabaseWithAppUsers>;

// ---------------------------------------------------------------------------
// Errors. Same shape as lib/auth/cron.ts: explicit readonly status, name set.
// ---------------------------------------------------------------------------

export class UnauthenticatedError extends Error {
  readonly status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

// ---------------------------------------------------------------------------
// Role ranking. Derived from APP_ROLES order (viewer < operator < admin) so the
// two cannot drift apart.
// ---------------------------------------------------------------------------

export const ROLE_RANK: Record<AppRole, number> = Object.fromEntries(
  APP_ROLES.map((role, index) => [role, index]),
) as Record<AppRole, number>;

/**
 * Throws unless `actual` is at least as privileged as `required`.
 *
 * `null` means "authenticated with Supabase but no app_users row" — allow-listed
 * enough to hold a session, not provisioned enough to do anything. That is a 403,
 * not a 401: the identity is known, the authorization is absent.
 */
export function assertRole(actual: AppRole | null, required: AppRole): void {
  if (actual === null) {
    throw new ForbiddenError("No dashboard role assigned");
  }
  if (ROLE_RANK[actual] < ROLE_RANK[required]) {
    throw new ForbiddenError(`Requires ${required}; caller is ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type AppUser = {
  id: string;
  userId: string;
  email: string;
  role: AppRole;
};

type AppUserRow = DatabaseWithAppUsers["public"]["Tables"]["app_users"]["Row"];

function toAppUser(row: AppUserRow): AppUser {
  return { id: row.id, userId: row.user_id, email: row.email, role: row.role };
}

const UNIQUE_VIOLATION = "23505";

export function createAuthStore(db: Db) {
  async function getAppUser(userId: string): Promise<AppUser | null> {
    const { data, error } = await db
      .from("app_users")
      .select("id, user_id, email, role")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      throw new Error(
        `Failed to read app_users for ${userId}: ${error.message} (apply 0005_app_users_roles.sql)`,
      );
    }

    return data ? toAppUser(data as AppUserRow) : null;
  }

  /**
   * Insert-if-missing. An existing row's role is never overwritten from the
   * environment, so changing someone's role is a DB update, not a redeploy.
   */
  async function ensureAppUser(input: {
    userId: string;
    email: string;
    role: AppRole;
  }): Promise<AppUser> {
    const existing = await getAppUser(input.userId);
    if (existing) {
      return existing;
    }

    const { data, error } = await db
      .from("app_users")
      .insert({ user_id: input.userId, email: input.email, role: input.role })
      .select("id, user_id, email, role")
      .single();

    if (error) {
      // Concurrent first logins race here; the loser re-reads the winner's row.
      if (error.code === UNIQUE_VIOLATION) {
        const raced = await getAppUser(input.userId);
        if (raced) {
          return raced;
        }
      }
      throw new Error(`Failed to create app_users row for ${input.email}: ${error.message}`);
    }

    return toAppUser(data as AppUserRow);
  }

  return { getAppUser, ensureAppUser };
}

export type AuthStore = ReturnType<typeof createAuthStore>;
