import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";

import { DASHBOARD_AREAS } from "./nav";

// An authenticated area must never be statically prerendered: the shell depends
// on the request's cookies, and a prerender would bake one user's view into the
// build. cacheComponents is off, so this is the documented opt-out.
export const dynamic = "force-dynamic";

/**
 * Structural shell only — no visual design. The design system is authored in
 * Claude Design and applied at unit UD (09-build-plan-v2.md §3). Plain semantic
 * HTML here is deliberate, not unfinished.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  // proxy.ts already turns signed-out traffic away. This catches the other case:
  // a valid Supabase session with no app_users row.
  if (!user) {
    redirect("/login");
  }

  return (
    <>
      <header>
        <p>Zyndix Engine</p>
        <p>
          {user.email} — {user.role}
        </p>
        <form action="/api/auth/signout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </header>

      <nav aria-label="Dashboard areas">
        <ul>
          {DASHBOARD_AREAS.map((area) => (
            <li key={area.href}>
              <Link href={area.href}>{area.label}</Link>
            </li>
          ))}
        </ul>
      </nav>

      <main>{children}</main>
    </>
  );
}
