"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/require-role";
import { applyPauseChange } from "@/lib/orchestrator/pause";
import { getActiveSetting, writeNewVersion } from "@/lib/settings";

/**
 * The Overview pause switch (09 §U9). Server Actions are reachable by a
 * direct POST, so the role is checked here, not by hiding the form: operator
 * or above. Writes operations_pause as a new version, like Telegram /pause.
 */
export async function setGlobalPauseAction(formData: FormData): Promise<void> {
  const user = await requireRole("operator");
  const intent = formData.get("intent");
  if (intent !== "pause" && intent !== "resume") throw new Error("Invalid pause intent");
  const reasonInput = String(formData.get("reason") ?? "").trim().slice(0, 200);

  await applyPauseChange(
    { getActiveSetting, writeNewVersion },
    {
      kind: "global",
      paused: intent === "pause",
      reason: intent === "pause" ? reasonInput || `dashboard pause by ${user.email}` : null,
    },
    `dashboard:${user.email}`,
  );
  revalidatePath("/dashboard");
}
