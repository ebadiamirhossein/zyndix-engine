import type { Metadata } from "next";

import { ROLE_RANK } from "@/lib/auth/core";
import { getCurrentUser } from "@/lib/auth/session";
import { readOperationsPause } from "@/lib/orchestrator/pause";
import { getActiveSetting } from "@/lib/settings";

import { setGlobalPauseAction } from "./actions";

export const metadata: Metadata = { title: "Overview — Zyndix Engine" };

export default async function Page() {
  const [user, pause] = await Promise.all([getCurrentUser(), readOperationsPause(getActiveSetting)]);
  const canOperate = user !== null && ROLE_RANK[user.role] >= ROLE_RANK.operator;

  return (
    <section>
      <h1>Overview</h1>

      <section aria-labelledby="pause-heading">
        <h2 id="pause-heading">Global pause</h2>
        <p>
          Status: <strong>{pause.global ? "Paused" : "Running"}</strong>
          {pause.global && pause.reason ? ` — ${pause.reason}` : null}
        </p>
        <p>
          {pause.version === null
            ? pause.source === "missing"
              ? "operations_pause has no active version yet (treated as running)."
              : "operations_pause could not be read — treated as paused until fixed."
            : `operations_pause v${pause.version}`}
        </p>
        <p>
          The pause stops sourcing, enrichment, qualification, verification, drafting, sending and reply
          classification. Stop and reconcile jobs keep running.
        </p>
        <p>
          Paused campaigns:{" "}
          {pause.paused_campaign_ids.length > 0 ? pause.paused_campaign_ids.join(", ") : "none"} (Telegram{" "}
          <code>/pause campaign &lt;id&gt;</code>)
        </p>

        {canOperate ? (
          <form action={setGlobalPauseAction}>
            {pause.global ? (
              <button type="submit" name="intent" value="resume">
                Resume engine
              </button>
            ) : (
              <>
                <label>
                  Reason <input type="text" name="reason" maxLength={200} />
                </label>{" "}
                <button type="submit" name="intent" value="pause">
                  Pause engine
                </button>
              </>
            )}
          </form>
        ) : (
          <p>Only an operator can change the pause.</p>
        )}
      </section>

      <p>This area will also hold: Due actions, pipeline, exceptions, campaign health, costs and outcomes (U21).</p>
    </section>
  );
}
