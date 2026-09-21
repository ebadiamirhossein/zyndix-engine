"use client";

import { useActionState } from "react";

import { requestMagicLink, type LoginState } from "./actions";

const INITIAL: LoginState = { status: "idle", message: "" };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(requestMagicLink, INITIAL);

  return (
    <form action={formAction}>
      <p>
        <label htmlFor="email">Email address</label>
      </p>
      <p>
        <input id="email" name="email" type="email" autoComplete="email" required />
      </p>
      <p>
        <button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send sign-in link"}
        </button>
      </p>
      {state.status !== "idle" ? (
        <p role="status" aria-live="polite">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
