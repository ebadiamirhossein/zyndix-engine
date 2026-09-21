import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { allowedRoleFor } from "@/lib/auth/allowlist";
import { createAuthStore } from "@/lib/auth/core";
import { createAuthClient } from "@/lib/auth/supabase";
import type { DatabaseWithAppUsers } from "@/types/database-extensions";
import type { SupabaseClient } from "@supabase/supabase-js";

const store = createAuthStore(db as unknown as SupabaseClient<DatabaseWithAppUsers>);

/**
 * Magic-link landing. Exchanges the code for a session, then provisions the
 * app_users row from DASHBOARD_ALLOWED_EMAILS on first sign-in only.
 *
 * The allow-list is re-checked here, not just at send time: a link issued while
 * an address was allow-listed must not still work after it was removed.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  const failure = (reason: string): NextResponse => {
    console.warn(`[auth] callback rejected: ${reason}`);
    return NextResponse.redirect(new URL("/login?error=1", url.origin));
  };

  if (!code) {
    return failure("no code parameter");
  }

  const supabase = await createAuthClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user?.email) {
    return failure(error?.message ?? "no email on exchanged session");
  }

  const role = allowedRoleFor(data.user.email);
  if (role === null) {
    await supabase.auth.signOut();
    return failure("email not on DASHBOARD_ALLOWED_EMAILS");
  }

  await store.ensureAppUser({ userId: data.user.id, email: data.user.email, role });

  return NextResponse.redirect(new URL("/dashboard", url.origin));
}
