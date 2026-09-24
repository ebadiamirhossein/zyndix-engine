import "server-only";

import { cache } from "react";
import type { User } from "@supabase/supabase-js";

import { db } from "@/lib/db";
import { createAuthStore, type AppUser } from "@/lib/auth/core";
import { createAuthClient } from "@/lib/auth/supabase";
import type { DatabaseWithAppUsers } from "@/types/database-extensions";
import type { SupabaseClient } from "@supabase/supabase-js";

const store = createAuthStore(db as unknown as SupabaseClient<DatabaseWithAppUsers>);

/**
 * The verified Supabase user for this request, or null.
 *
 * Uses getUser(), never getSession(): getUser() revalidates the JWT with the
 * auth server, while getSession() trusts whatever is in the cookie. Wrapped in
 * React cache() so a layout and its pages share one round trip per render pass
 * (Next 16 DAL guidance, node_modules/next/dist/docs/01-app/02-guides/authentication.md).
 */
export const getAuthUser = cache(async (): Promise<User | null> => {
  let supabase;
  try {
    supabase = await createAuthClient();
  } catch (error: unknown) {
    // Missing SUPABASE_ANON_KEY. Fail closed: an unconfigured deployment must
    // read as "nobody is signed in", never as a 500 that a mutating route could
    // be coaxed into treating as anything other than a refusal.
    console.warn(`[auth] no auth client: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const { data, error } = await supabase.auth.getUser();
  if (error) {
    return null;
  }
  return data.user;
});

/** The signed-in operator's app_users row, or null if unauthenticated or unprovisioned. */
export const getCurrentUser = cache(async (): Promise<AppUser | null> => {
  const user = await getAuthUser();
  if (!user) {
    return null;
  }
  return store.getAppUser(user.id);
});

export { store as authStore };
