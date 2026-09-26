import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { parseOrThrow } from "@/lib/validation";
import {
  apifyActorTemplatesSchema,
  cadenceDefaultSchema,
  capacityDefaultsSchema,
  ctaVariantsSchema,
  proofPointsSchema,
  complianceFooterSchema,
  segmentsSettingsSchema,
  sendPolicySchema,
  evidencePolicySchema,
  emailSequenceSchema,
  followupTemplatesSchema,
  sendWindowsSchema,
  operationsPauseSchema,
  orchestratorBudgetsSchema,
  researchPolicySchema,
  replyPolicySchema,
} from "@/lib/validation/jsonb";
import type { Database, Json } from "@/types/database";

/** Settings keys defined in doc 02 §4.1 and seeded from doc 04. */
export const SETTING_KEYS = [
  "icp_rubric",
  "segments",
  "qualifier_prompt",
  "writer_prompt_email",
  "writer_prompt_linkedin",
  "reply_classifier_prompt",
  "cadence_default",
  "cta_variants",
  "proof_points",
  "compliance_footer",
  "capacity_defaults",
  "send_windows",
  "send_policy",
  "evidence_policy",
  "email_sequence",
  "followup_templates",
  // Wave 1 (09 §U9, §UR, §U7). Seeded by scripts/seed-wave1-settings.ts.
  "operations_pause",
  "orchestrator_budgets",
  "research_policy",
  "reply_policy",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export type ActiveSetting<T = unknown> = {
  id: string;
  key: string;
  version: number;
  value: T;
  changed_by: string | null;
  change_note: string | null;
  updated_at: string | null;
};

const CACHE_TTL_MS = 60_000;

type CacheEntry = { data: ActiveSetting; fetchedAt: number };

const keyCache = new Map<string, CacheEntry>();
let allActiveCache: { data: ActiveSetting[]; fetchedAt: number } | null = null;

export function clearSettingsCache(): void {
  keyCache.clear();
  allActiveCache = null;
}

function schemaForKey(key: string): z.ZodType {
  switch (key) {
    case "segments":
      return segmentsSettingsSchema;
    case "cadence_default":
      return cadenceDefaultSchema;
    case "cta_variants":
      return ctaVariantsSchema;
    case "proof_points":
      return proofPointsSchema;
    case "compliance_footer":
      return complianceFooterSchema;
    case "capacity_defaults":
      return capacityDefaultsSchema;
    case "send_windows":
      return sendWindowsSchema;
    case "send_policy":
      return sendPolicySchema;
    case "evidence_policy":
      return evidencePolicySchema;
    case "email_sequence":
      return emailSequenceSchema;
    case "followup_templates":
      return followupTemplatesSchema;
    case "apify_actor_templates":
      return apifyActorTemplatesSchema;
    case "operations_pause":
      return operationsPauseSchema;
    case "orchestrator_budgets":
      return orchestratorBudgetsSchema;
    case "research_policy":
      return researchPolicySchema;
    case "reply_policy":
      return replyPolicySchema;
    default:
      return z.string().min(1);
  }
}

function rowToSetting(row: {
  id: string;
  key: string;
  version: number;
  value: Json | null;
  changed_by: string | null;
  change_note: string | null;
  updated_at: string | null;
}): ActiveSetting {
  const value = parseOrThrow(schemaForKey(row.key), row.value, `settings:${row.key}`);
  return { ...row, value };
}

export function createSettingsStore(db: SupabaseClient<Database>) {
  async function getActiveSetting(key: string): Promise<ActiveSetting> {
    const cached = keyCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }

    const { data, error } = await db
      .from("settings")
      .select("id, key, version, value, changed_by, change_note, updated_at")
      .eq("key", key)
      .eq("active", true)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch setting "${key}": ${error.message}`);
    }
    if (!data) {
      throw new Error(`No active setting found for key "${key}"`);
    }

    const setting = rowToSetting(data);
    keyCache.set(key, { data: setting, fetchedAt: Date.now() });
    return setting;
  }

  async function getAllActiveSettings(): Promise<ActiveSetting[]> {
    if (allActiveCache && Date.now() - allActiveCache.fetchedAt < CACHE_TTL_MS) {
      return allActiveCache.data;
    }

    const { data, error } = await db
      .from("settings")
      .select("id, key, version, value, changed_by, change_note, updated_at")
      .eq("active", true)
      .order("key");

    if (error) {
      throw new Error(`Failed to fetch active settings: ${error.message}`);
    }

    const settings = (data ?? []).map(rowToSetting);
    allActiveCache = { data: settings, fetchedAt: Date.now() };
    for (const setting of settings) {
      keyCache.set(setting.key, { data: setting, fetchedAt: Date.now() });
    }
    return settings;
  }

  async function writeNewVersion(
    key: string,
    value: unknown,
    changedBy: string,
    changeNote: string,
  ): Promise<ActiveSetting> {
    if (!changeNote.trim()) {
      throw new Error("change_note is required and must be non-empty");
    }

    const parsedValue = parseOrThrow(schemaForKey(key), value, `settings:write:${key}`);

    const { data: current, error: readError } = await db
      .from("settings")
      .select("id, version")
      .eq("key", key)
      .eq("active", true)
      .maybeSingle();

    if (readError) {
      throw new Error(
        `Failed to read current active version for "${key}": ${readError.message}`,
      );
    }

    const nextVersion = (current?.version ?? 0) + 1;

    if (current) {
      const { error: deactivateError } = await db
        .from("settings")
        .update({ active: false })
        .eq("id", current.id);

      if (deactivateError) {
        throw new Error(
          `Failed to deactivate previous setting for "${key}": ${deactivateError.message}`,
        );
      }
    }

    const { data: inserted, error: insertError } = await db
      .from("settings")
      .insert({
        key,
        version: nextVersion,
        value: parsedValue as Json,
        active: true,
        changed_by: changedBy,
        change_note: changeNote,
      })
      .select("id, key, version, value, changed_by, change_note, updated_at")
      .single();

    if (insertError || !inserted) {
      throw new Error(
        `Failed to insert setting v${nextVersion} for "${key}": ${insertError?.message ?? "no row returned"}`,
      );
    }

    clearSettingsCache();
    return rowToSetting(inserted);
  }

  return {
    getActiveSetting,
    getAllActiveSettings,
    writeNewVersion,
  };
}
