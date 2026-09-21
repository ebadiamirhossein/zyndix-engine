"use server";

import { headers } from "next/headers";

import { allowedRoleFor } from "@/lib/auth/allowlist";
import { createAuthClient } from "@/lib/auth/supabase";

export type LoginState = { status: "idle" | "sent" | "error"; message: string };

/**
 * Magic-link sign-in.
 *
 * The response is identical whether or not the email is allow-listed. Telling a
 * stranger "that address is not on the list" confirms which addresses are, and
 * this is an internal tool with a handful of users.
 */
export async function requestMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  const sent: LoginState = {
    status: "sent",
    message: "If that address may access this dashboard, a sign-in link is on its way.",
  };

  if (!email.includes("@")) {
    return { status: "error", message: "Enter an email address." };
  }

  if (allowedRoleFor(email) === null) {
    return sent;
  }

  const host = (await headers()).get("host");
  const proto = process.env.NODE_ENV === "production" ? "https" : "http";

  const supabase = await createAuthClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${proto}://${host}/api/auth/callback`,
      shouldCreateUser: true,
    },
  });

  if (error) {
    console.warn(`[auth] signInWithOtp failed: ${error.message}`);
    return { status: "error", message: "Could not send the link. Try again." };
  }

  return sent;
}
