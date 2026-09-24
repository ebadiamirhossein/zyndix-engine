import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import type { DatabaseWithAppUsers } from "@/types/database-extensions";

/**
 * Cookie-bound Supabase client for the signed-in operator.
 *
 * Uses the anon key, NOT the service-role key: this client carries the user's
 * session and is only ever used to establish and read identity. Every data read
 * still goes through `lib/db.ts` (service role), because 0001 grants tables to
 * service_role alone and leaves anon/authenticated with nothing.
 *
 * The anon key is deliberately not NEXT_PUBLIC_. Sign-in runs through a server
 * action and the callback runs in a route handler, so no client component ever
 * holds a Supabase client.
 *
 * Per @supabase/ssr: create a new client per request, never share one.
 */
export async function createAuthClient(): Promise<SupabaseClient<DatabaseWithAppUsers>> {
  // Read cookies first: this is what marks the caller as request-scoped. Throwing
  // on missing env before it would make a misconfiguration look like a build error.
  const cookieStore = await cookies();

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  }

  return createServerClient<DatabaseWithAppUsers>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. proxy.ts refreshes the session
          // on every request, so dropping the write here is safe.
        }
      },
    },
  });
}
