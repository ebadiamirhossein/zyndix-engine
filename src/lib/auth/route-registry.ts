import type { AppRole } from "@/types/enums";

/**
 * Every mutating route in the app, and how it is authorized.
 *
 * - `session` — authorized by requireSession()/requireRole(). An unauthenticated
 *   request must get 401, and an under-privileged one 403.
 * - `machine` — authorized by a shared secret, not a user session (cron, provider
 *   webhooks). These have no role.
 *
 * scripts/test-u1-auth.ts iterates this table, so adding a mutating route without
 * classifying it here is what the test is designed to catch. U22's DoD extends the
 * same table to the full authorization matrix.
 *
 * Pure data: no next/server import, so scripts can read it.
 */
export type RouteAuth =
  | { path: string; method: "POST" | "PATCH" | "PUT" | "DELETE"; auth: "session"; role: AppRole }
  | { path: string; method: "POST" | "PATCH" | "PUT" | "DELETE"; auth: "machine" };

export const MUTATING_ROUTES: readonly RouteAuth[] = [
  { path: "/api/auth/signout", method: "POST", auth: "session", role: "viewer" },
  { path: "/api/webhooks/telegram", method: "POST", auth: "machine" },
] as const;

export function sessionRoutes(): readonly Extract<RouteAuth, { auth: "session" }>[] {
  return MUTATING_ROUTES.filter(
    (route): route is Extract<RouteAuth, { auth: "session" }> => route.auth === "session",
  );
}
