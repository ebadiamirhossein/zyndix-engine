import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";

import { LoginForm } from "./form";

export const metadata: Metadata = { title: "Sign in — Zyndix Engine" };

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getCurrentUser()) {
    redirect("/dashboard");
  }

  return (
    <main>
      <h1>Zyndix Engine</h1>
      <p>Sign in with a link sent to your email.</p>
      <LoginForm />
    </main>
  );
}
