import { orchestrator_budgets as SEED_BUDGETS, operations_pause as SEED_PAUSE } from "@/lib/settings/seed-content";
import {
  operationsPauseSchema,
  orchestratorBudgetsSchema,
  type OperationsPause,
  type OrchestratorBudgets,
} from "@/lib/validation/jsonb";

// Pause and budget settings (09 §U9). Pure: the settings reader and writer are
// injected, so the orchestrator, the send stage, Telegram and the dashboard
// share one reading of operations_pause.
//
// Missing vs unreadable. The Wave 1 seed is a dry run until the operator
// applies it, so a missing row is expected: a missing operations_pause is
// "not paused" and a missing orchestrator_budgets is the seed value. Any
// OTHER failure to read operations_pause (DB error, a row that fails Zod) is
// treated as paused: a pause switch that cannot be read must fail closed.

export type SettingReader = (key: string) => Promise<{ version: number; value: unknown }>;
export type SettingWriter = (key: string, value: unknown, changedBy: string, changeNote: string) => Promise<unknown>;

export type PauseState = OperationsPause & {
  /** Active version; null when the row is missing or unreadable. */
  version: number | null;
  source: "setting" | "missing" | "unreadable";
};

/** settings/core.ts getActiveSetting throws exactly this for a key with no active row. */
export function isMissingSetting(error: unknown, key: string): boolean {
  return error instanceof Error && error.message === `No active setting found for key "${key}"`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readOperationsPause(getSetting: SettingReader): Promise<PauseState> {
  let row: { version: number; value: unknown };
  try {
    row = await getSetting("operations_pause");
  } catch (error) {
    if (isMissingSetting(error, "operations_pause")) {
      console.warn("[orchestrator] operations_pause has no active row: treated as not paused");
      return { ...SEED_PAUSE, paused_campaign_ids: [], version: null, source: "missing" };
    }
    console.error(`[orchestrator] operations_pause unreadable, failing closed: ${message(error)}`);
    return {
      global: true,
      reason: `operations_pause unreadable: ${message(error).slice(0, 200)}`,
      paused_campaign_ids: [],
      version: null,
      source: "unreadable",
    };
  }
  const parsed = operationsPauseSchema.safeParse(row.value);
  if (!parsed.success) {
    console.error("[orchestrator] operations_pause fails its schema, failing closed");
    return { global: true, reason: "operations_pause invalid", paused_campaign_ids: [], version: row.version, source: "unreadable" };
  }
  return { ...parsed.data, version: row.version, source: "setting" };
}

export function isCampaignPaused(pause: Pick<OperationsPause, "paused_campaign_ids">, campaignId: string | null): boolean {
  return campaignId !== null && pause.paused_campaign_ids.includes(campaignId);
}

export async function readOrchestratorBudgets(
  getSetting: SettingReader,
): Promise<{ budgets: OrchestratorBudgets; version: number | null }> {
  try {
    const row = await getSetting("orchestrator_budgets");
    return { budgets: orchestratorBudgetsSchema.parse(row.value), version: row.version };
  } catch (error) {
    if (!isMissingSetting(error, "orchestrator_budgets")) throw error;
    console.warn("[orchestrator] orchestrator_budgets has no active row: using the seed value");
    return { budgets: orchestratorBudgetsSchema.parse(SEED_BUDGETS), version: null };
  }
}

// ---------------------------------------------------------------------------
// Writing (Telegram /pause, the dashboard switch)
// ---------------------------------------------------------------------------

export type PauseChange =
  | { kind: "global"; paused: boolean; reason: string | null }
  | { kind: "campaign"; paused: boolean; campaignId: string };

export type PauseWriteResult =
  | { changed: true; value: OperationsPause; previousVersion: number | null }
  | { changed: false; value: OperationsPause; version: number | null };

/**
 * Applies one change to operations_pause as a new version (v+1). The current
 * value is the base, so a global /pause keeps the paused campaign list and a
 * campaign change keeps the global switch. No-op changes write nothing.
 * Refuses to build on an unreadable row: overwriting it could silently lift a
 * pause the operator cannot see.
 */
export async function applyPauseChange(
  deps: { getActiveSetting: SettingReader; writeNewVersion: SettingWriter },
  change: PauseChange,
  changedBy: string,
): Promise<PauseWriteResult> {
  const current = await readOperationsPause(deps.getActiveSetting);
  if (current.source === "unreadable") {
    throw new Error(`operations_pause is unreadable (${current.reason}); fix the row before changing it`);
  }
  const base: OperationsPause = {
    global: current.global,
    reason: current.reason,
    paused_campaign_ids: [...current.paused_campaign_ids],
  };

  let next: OperationsPause;
  let note: string;
  if (change.kind === "global") {
    next = { ...base, global: change.paused, reason: change.paused ? change.reason : null };
    note = change.paused ? `global pause on${change.reason ? `: ${change.reason}` : ""}` : "global pause off";
  } else {
    const ids = new Set(base.paused_campaign_ids);
    if (change.paused) ids.add(change.campaignId);
    else ids.delete(change.campaignId);
    next = { ...base, paused_campaign_ids: [...ids].sort() };
    note = `campaign ${change.campaignId} ${change.paused ? "paused" : "resumed"}`;
  }

  const same =
    next.global === base.global &&
    next.reason === base.reason &&
    next.paused_campaign_ids.length === base.paused_campaign_ids.length &&
    next.paused_campaign_ids.every((id) => base.paused_campaign_ids.includes(id));
  if (same && current.source === "setting") return { changed: false, value: next, version: current.version };

  const valid = operationsPauseSchema.parse(next);
  await deps.writeNewVersion("operations_pause", valid, changedBy, note);
  return { changed: true, value: valid, previousVersion: current.version };
}
