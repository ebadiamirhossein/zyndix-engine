import { NextResponse } from "next/server";

import { authErrorResponse, requireSession } from "@/lib/auth/require-role";
import { createAuthClient } from "@/lib/auth/supabase";

export async function POST(req: Request): Promise<NextResponse> {
  try {
    await requireSession();
  } catch (error: unknown) {
    return authErrorResponse(error);
  }

  const supabase = await createAuthClient();
  await supabase.auth.signOut();

  return NextResponse.redirect(new URL("/login", new URL(req.url).origin), { status: 303 });
}
