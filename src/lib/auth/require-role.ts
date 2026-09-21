import "server-only";

import { NextResponse } from "next/server";

import {
  ForbiddenError,
  UnauthenticatedError,
  assertRole,
  type AppUser,
} from "@/lib/auth/core";
import { getAuthUser, getCurrentUser } from "@/lib/auth/session";
import type { AppRole } from "@/types/enums";

/**
 * The authorization primitive. Every server action and mutating route handler
 * calls one of these — brief §3: "Authorize every server operation; hiding
 * buttons is insufficient."
 *
 * proxy.ts does an optimistic cookie check to keep signed-out traffic off the
 * dashboard. It is not a security boundary. This is.
 */
export async function requireSession(): Promise<AppUser> {
  const user = await getAuthUser();
  if (!user) {
    throw new UnauthenticatedError();
  }

  const appUser = await getCurrentUser();
  if (!appUser) {
    throw new ForbiddenError("No dashboard role assigned");
  }

  return appUser;
}

export async function requireRole(required: AppRole): Promise<AppUser> {
  const appUser = await requireSession();
  assertRole(appUser.role, required);
  return appUser;
}

/**
 * Maps an auth error to a response. Mirrors unauthorizedResponse() in
 * lib/auth/cron.ts: body is `{ error: ... }` and nothing else leaks.
 */
export function authErrorResponse(error: unknown): NextResponse {
  if (error instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  throw error;
}

export { ForbiddenError, UnauthenticatedError, assertRole, type AppUser };
