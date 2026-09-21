import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next 16 renamed Middleware to Proxy (node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md).
 * Same functionality, same position — `app/` lives under `src/`, so this file does too.
 *
 * Two jobs:
 *   1. Refresh the Supabase session cookie. getUser() is a call to the auth
 *      server, not the database — the @supabase/ssr docs are explicit that
 *      skipping it causes random logouts and early session termination.
 *   2. Keep signed-out traffic off /dashboard.
 *
 * This is convenience, not a security boundary. Authorization lives in
 * requireRole() next to the data, per Next's Data Access Layer guidance.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  // Unconfigured env must not 500 every route; the dashboard fails closed below.
  if (!url || !anonKey) {
    return request.nextUrl.pathname.startsWith("/dashboard")
      ? NextResponse.redirect(new URL("/login", request.url))
      : response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && request.nextUrl.pathname.startsWith("/dashboard")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
