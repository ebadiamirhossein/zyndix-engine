import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import type { AnthropicClient } from "@/lib/integrations/anthropic";
import { parseJsonText } from "@/lib/integrations/anthropic";
import { createStateStore } from "@/lib/state/core";
import { parseOrThrow } from "@/lib/validation";
import { EVIDENCE_SOURCES } from "@/lib/validation/jsonb";
import { qualifierOutputSchema } from "@/lib/validation/llm";
import type { Database, Json } from "@/types/database";

type QualifierOutput = z.infer<typeof qualifierOutputSchema>;

const EVIDENCE_SOURCE_ALIASES: Record<string, (typeof EVIDENCE_SOURCES)[number]> = {
  website: "website",
  web: "website",
  site: "website",
  apify_site: "website",
  apify_tech: "website",
  tech: "website",
  linkedin: "linkedin",
  li: "linkedin",
  apify_li_posts: "linkedin",
  jobs: "jobs",
  job: "jobs",
  careers: "jobs",
  apollo: "apollo",
};

function normalizeEvidenceSource(source: string): (typeof EVIDENCE_SOURCES)[number] | string {
  const key = source.toLowerCase().trim();
  if (key in EVIDENCE_SOURCE_ALIASES) {
    return EVIDENCE_SOURCE_ALIASES[key]!;
  }
  if (key.startsWith("apify_")) {
    if (key.includes("li") || key.includes("linkedin")) {
      return "linkedin";
    }
    return "website";
  }
  return source;
}

function normalizeQualifierRawOutput(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return raw;
  }

  const obj = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(obj.evidence)) {
    obj.evidence = obj.evidence.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return item;
      }
      const entry = { ...(item as Record<string, unknown>) };
      if (typeof entry.source === "string") {
        entry.source = normalizeEvidenceSource(entry.source);
      }
      return entry;
    });
  }
  return obj;
}

export type QualifyStageSummary = {
  leads_picked: number;
  qualified: number;
  parked_disqualified: number;
  parked_low_score: number;
  failed: number;
  avg_fit_score: number | null;
  tokens_used: number;
  est_cost_usd: number;
};

type QualifyDeps = {
  db: SupabaseClient<Database>;
  anthropic: AnthropicClient;
  getActiveSetting: (key: string) => Promise<{ version: number; value: unknown }>;
  transition: ReturnType<typeof createStateStore>["transition"];
};

type LeadPick = {
  id: string;
  company_id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company: {
    name: string;
    domain: string | null;
    industry: string | null;
    employee_range: string | null;
    country: string | null;
    city: string | null;
  };
};

const ENRICHMENT_SOURCES = {
  site: "apify_site",
  tech: "apify_tech",
  li_posts: "apify_li_posts",
} as const;

function qualifyBatchSize(): number {
  const raw = process.env.QUALIFY_BATCH_SIZE ?? "5";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function qualifyMaxSiteChars(): number {
  const raw = process.env.QUALIFY_MAX_SITE_CHARS ?? "20000";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000;
}

function qualifyMinScore(): number {
  const raw = process.env.QUALIFY_MIN_SCORE ?? "50";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 50;
}

function qualifyTemperature(): number {
  const raw = process.env.QUALIFY_TEMPERATURE ?? "0.1";
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    return 0.1;
  }
  return Math.min(0.2, Math.max(0, parsed));
}

function defaultAnthropicModel(): string {
  return process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
}

async function resolveModel(
  getActiveSetting: QualifyDeps["getActiveSetting"],
): Promise<string> {
  try {
    const setting = await getActiveSetting("anthropic_model");
    if (typeof setting.value === "string" && setting.value.trim()) {
      return setting.value.trim();
    }
  } catch {
    // optional setting — not seeded in v1
  }
  return defaultAnthropicModel();
}

function buildSystemPrompt(
  template: string,
  icpRubric: string,
  segments: unknown,
): string {
  return template
    .replace("{{icp_rubric}}", icpRubric)
    .replace("{{segments}}", JSON.stringify(segments, null, 2));
}

function extractSiteText(payload: unknown): string {
  if (!Array.isArray(payload)) {
    return "";
  }

  const parts: string[] = [];
  for (const page of payload) {
    if (typeof page !== "object" || page === null) {
      continue;
    }
    const record = page as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : "unknown";
    const text =
      (typeof record.markdown === "string" && record.markdown) ||
      (typeof record.text === "string" && record.text) ||
      "";
    if (text) {
      parts.push(`--- ${url} ---\n${text}`);
    }
  }
  return parts.join("\n\n");
}

function truncateSiteText(
  text: string,
  maxChars: number,
  leadId: string,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  console.log(
    `[qualify] lead ${leadId}: site text truncated ${text.length} → ${maxChars} chars`,
  );
  return { text: text.slice(0, maxChars), truncated: true };
}

function groupPayloadsBySource(
  rows: Array<{ source: string | null; payload: Json | null }>,
): Record<string, unknown> {
  const grouped: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.source) {
      grouped[row.source] = row.payload;
    }
  }
  return grouped;
}

function selectMostRecentNonErrorPayloadsBySource(
  rows: Array<{ source: string | null; payload: Json | null }>,
): Record<string, unknown> {
  // Caller is expected to pass rows ordered by fetched_at DESC (newest first).
  const selected: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row.source) continue;
    if (seen.has(row.source)) continue;

    // Prefer the first (newest) non-error row. If we only see errors, we will
    // fall back to the newest error row at the end.
    if (!payloadIsErrorRow(row.payload)) {
      selected[row.source] = row.payload;
      seen.add(row.source);
    }
  }

  // Fill any remaining sources with the newest row (even if error) so the
  // caller can treat it as UNAVAILABLE.
  for (const row of rows) {
    if (!row.source) continue;
    if (row.source in selected) continue;
    selected[row.source] = row.payload;
  }

  return selected;
}

export function __testOnly_selectMostRecentNonErrorPayloadsBySource(
  rows: Array<{ source: string | null; payload: Json | null }>,
): Record<string, unknown> {
  return selectMostRecentNonErrorPayloadsBySource(rows);
}

function buildLeadInput(
  lead: LeadPick,
  grouped: Record<string, unknown>,
  maxSiteChars: number,
): { userJson: string; siteTruncated: boolean } {
  const sitePayload = grouped[ENRICHMENT_SOURCES.site];
  const siteRaw = extractSiteText(sitePayload);
  const { text: crawlText, truncated } = truncateSiteText(
    siteRaw,
    maxSiteChars,
    lead.id,
  );

  const techPayload = grouped[ENRICHMENT_SOURCES.tech];

  const website: Record<string, unknown> = {
    crawl: crawlText || sitePayload || null,
    tech_stack: payloadIsErrorRow(techPayload)
      ? {
          status:
            "UNAVAILABLE — we failed to fetch this. You know NOTHING about their tech stack. Do not infer absence of tools.",
        }
      : (techPayload ?? null),
  };

  if (truncated) {
    website.crawl_truncated = true;
    website.crawl_original_chars = siteRaw.length;
  }

  const input = {
    apollo: {
      first_name: lead.first_name,
      last_name: lead.last_name,
      title: lead.title,
      company_name: lead.company.name,
      domain: lead.company.domain,
      industry: lead.company.industry,
      employee_range: lead.company.employee_range,
      country: lead.company.country,
      city: lead.company.city,
    },
    website,
    linkedin: grouped[ENRICHMENT_SOURCES.li_posts] ?? null,
  };

  return { userJson: JSON.stringify(input, null, 2), siteTruncated: truncated };
}

function problemHypothesisForDb(output: QualifierOutput): string {
  const hypothesis = output.problem_hypothesis?.trim();
  if (hypothesis) {
    return hypothesis;
  }
  if (output.disqualify_reason?.trim()) {
    return `(disqualified: ${output.disqualify_reason.trim()})`;
  }
  return "(no hypothesis)";
}

async function countQualifyFailures(
  db: SupabaseClient<Database>,
  leadId: string,
): Promise<number> {
  const { count, error } = await db
    .from("lead_events")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("event", "qualify_failed");

  if (error) {
    throw new Error(`Failed to count qualify_failed for ${leadId}: ${error.message}`);
  }
  return count ?? 0;
}

async function countEnrichmentRetries(
  db: SupabaseClient<Database>,
  leadId: string,
): Promise<number> {
  const { count, error } = await db
    .from("lead_events")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("event", "enrichment_retry");

  if (error) {
    throw new Error(`Failed to count enrichment_retry for ${leadId}: ${error.message}`);
  }
  return count ?? 0;
}

function payloadIsErrorRow(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "string"
  );
}

function allPayloadRowsAreErrors(
  payloadRows: Array<{ source: string | null; payload: Json | null }>,
): boolean {
  if (payloadRows.length === 0) {
    return true;
  }
  return payloadRows.every((row) => payloadIsErrorRow(row.payload));
}

async function retryEnrichmentOrPark(
  deps: QualifyDeps,
  lead: LeadPick,
  payloadRows: Array<{ source: string | null; payload: Json | null }>,
): Promise<"retried" | "parked"> {
  const priorRetries = await countEnrichmentRetries(deps.db, lead.id);
  const attempt = priorRetries + 1;

  const sources = payloadRows
    .map((row) => row.source)
    .filter((s): s is string => Boolean(s));

  if (attempt <= 3) {
    const retryAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await deps.transition(
      lead.id,
      "qualifying",
      "enriching",
      "enrichment_retry",
      { attempt, sources, reason: "all_enrichment_payloads_are_errors" },
      retryAt,
    );

    await deps.db
      .from("companies")
      .update({ status: "enriching", park_reason: null })
      .eq("id", lead.company_id);

    console.log(
      `[qualify] lead ${lead.id} enrichment unavailable; retry ${attempt}/3 at ${retryAt}`,
    );
    return "retried";
  }

  await parkCompany(deps.db, lead.company_id, "enrichment_unavailable_3x");
  await deps.transition(lead.id, "qualifying", "parked", "parked", {
    park_reason: "enrichment_unavailable_3x",
    attempt,
    sources,
    reason: "all_enrichment_payloads_are_errors",
  });
  return "parked";
}

async function writeQualification(
  db: SupabaseClient<Database>,
  leadId: string,
  output: QualifierOutput,
  promptVersion: number,
  model: string,
): Promise<void> {
  const row = {
    lead_id: leadId,
    fit_score: output.fit_score,
    segment: output.segment,
    problem_hypothesis: problemHypothesisForDb(output),
    evidence: output.evidence as Json,
    triggers: output.triggers as Json,
    visible_tools: output.visible_tools as Json,
    recommended_angle: output.recommended_angle,
    disqualify_reason: output.disqualify_reason,
    prompt_version: promptVersion,
    model,
  };

  const { error: upsertError } = await db
    .from("qualification")
    .upsert(row, { onConflict: "lead_id" });

  if (upsertError) {
    throw new Error(`Failed to upsert qualification for ${leadId}: ${upsertError.message}`);
  }

  const { error: historyError } = await db.from("qualification_history").insert(row);
  if (historyError) {
    throw new Error(
      `Failed to insert qualification_history for ${leadId}: ${historyError.message}`,
    );
  }
}

async function parkCompany(
  db: SupabaseClient<Database>,
  companyId: string,
  parkReason: string,
): Promise<void> {
  const { error } = await db
    .from("companies")
    .update({ park_reason: parkReason, status: "parked" })
    .eq("id", companyId);

  if (error) {
    throw new Error(`Failed to park company ${companyId}: ${error.message}`);
  }
}

export async function runQualifyStage(
  deps: QualifyDeps,
  options?: {
    limit?: number;
  /** Only these leads (scripts and tests; production passes nothing and picks by state). */
  leadIds?: string[];
  },
): Promise<QualifyStageSummary> {
  const batchCap = options?.limit ?? qualifyBatchSize();
  const maxSiteChars = qualifyMaxSiteChars();
  const minScore = qualifyMinScore();

  const summary: QualifyStageSummary = {
    leads_picked: 0,
    qualified: 0,
    parked_disqualified: 0,
    parked_low_score: 0,
    failed: 0,
    avg_fit_score: null,
    tokens_used: 0,
    est_cost_usd: 0,
  };

  const [qualifierSetting, icpSetting, segmentsSetting, model] = await Promise.all([
    deps.getActiveSetting("qualifier_prompt"),
    deps.getActiveSetting("icp_rubric"),
    deps.getActiveSetting("segments"),
    resolveModel(deps.getActiveSetting),
  ]);

  const systemPrompt = buildSystemPrompt(
    String(qualifierSetting.value),
    String(icpSetting.value),
    segmentsSetting.value,
  );

  let pickQuery = deps.db
    .from("leads")
    .select(
      "id, company_id, first_name, last_name, title, companies!inner(name, domain, industry, employee_range, country, city)",
    )
    .eq("state", "qualifying");
  if (options?.leadIds) pickQuery = pickQuery.in("id", options.leadIds);
  const { data: rows, error: pickError } = await pickQuery
    .order("created_at", { ascending: true })
    .limit(batchCap);

  if (pickError) {
    throw new Error(`Failed to pick qualifying leads: ${pickError.message}`);
  }

  const leads: LeadPick[] = (rows ?? []).map((row) => ({
    id: row.id,
    company_id: row.company_id!,
    first_name: row.first_name,
    last_name: row.last_name,
    title: row.title,
    company: row.companies as LeadPick["company"],
  }));

  summary.leads_picked = leads.length;
  if (leads.length === 0) {
    console.log("[qualify] no qualifying leads to process");
    return summary;
  }

  const fitScores: number[] = [];

  for (const lead of leads) {
    try {
      const { data: payloadRows, error: payloadError } = await deps.db
        .from("enrichment_payloads")
        .select("source, payload")
        .eq("lead_id", lead.id);

      if (payloadError) {
        throw new Error(
          `Failed to load enrichment_payloads for ${lead.id}: ${payloadError.message}`,
        );
      }

      if (!payloadRows || payloadRows.length === 0) {
        throw new Error(
          `PIPELINE_BUG: lead ${lead.id} reached qualifying with zero enrichment_payloads rows`,
        );
      }

      if (allPayloadRowsAreErrors(payloadRows)) {
        await retryEnrichmentOrPark(deps, lead, payloadRows);
        continue;
      }

      const grouped = selectMostRecentNonErrorPayloadsBySource(payloadRows);
      const { userJson } = buildLeadInput(lead, grouped, maxSiteChars);

      const completion = await deps.anthropic.complete({
        system: systemPrompt,
        user: userJson,
        temperature: qualifyTemperature(),
        model,
        maxTokens: 4096,
      });

      summary.tokens_used += completion.inputTokens + completion.outputTokens;
      summary.est_cost_usd += completion.estCostUsd;

      const rawJson = parseJsonText(completion.text);
      const output = parseOrThrow(
        qualifierOutputSchema,
        normalizeQualifierRawOutput(rawJson),
        `qualify:${lead.id}`,
      );

      await writeQualification(
        deps.db,
        lead.id,
        output,
        qualifierSetting.version,
        completion.model,
      );

      await deps.db.from("lead_events").insert({
        lead_id: lead.id,
        event: "qualify_completed",
        detail: {
          fit_score: output.fit_score,
          segment: output.segment,
          model: completion.model,
          prompt_version: qualifierSetting.version,
          input_tokens: completion.inputTokens,
          output_tokens: completion.outputTokens,
          est_cost_usd: completion.estCostUsd,
        },
      });

      if (output.disqualify_reason) {
        const parkReason = output.disqualify_reason;
        await parkCompany(deps.db, lead.company_id, parkReason);
        await deps.transition(lead.id, "qualifying", "parked", "disqualified", {
          park_reason: parkReason,
          fit_score: output.fit_score,
          segment: output.segment,
        });
        summary.parked_disqualified += 1;
        continue;
      }

      if (output.fit_score < minScore) {
        const parkReason = `low_fit_score_${output.fit_score}`;
        await parkCompany(deps.db, lead.company_id, parkReason);
        await deps.transition(lead.id, "qualifying", "parked", "parked", {
          park_reason: parkReason,
          fit_score: output.fit_score,
          segment: output.segment,
        });
        summary.parked_low_score += 1;
        continue;
      }

      await deps.db
        .from("companies")
        .update({ status: "qualified", segment: output.segment })
        .eq("id", lead.company_id);

      await deps.transition(lead.id, "qualifying", "qualified", "qualified", {
        fit_score: output.fit_score,
        segment: output.segment,
        recommended_angle: output.recommended_angle,
      });

      fitScores.push(output.fit_score);
      summary.qualified += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const priorFailures = await countQualifyFailures(deps.db, lead.id);
      const attempt = priorFailures + 1;

      await deps.db.from("lead_events").insert({
        lead_id: lead.id,
        event: "qualify_failed",
        detail: { error: message, attempt },
      });

      if (attempt >= 3) {
        await parkCompany(deps.db, lead.company_id, "qualify_failed_3x");
        await deps.transition(lead.id, "qualifying", "parked", "qualify_failed", {
          park_reason: "qualify_failed_3x",
          error: message,
          attempt,
        });
        summary.failed += 1;
        console.log(`[qualify] lead ${lead.id} parked after 3 qualification failures`);
      } else {
        const retryAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const { error: retryError } = await deps.db
          .from("leads")
          .update({ next_action_at: retryAt })
          .eq("id", lead.id);

        if (retryError) {
          throw new Error(`Failed to schedule qualify retry for ${lead.id}: ${retryError.message}`);
        }
        summary.failed += 1;
        console.log(
          `[qualify] lead ${lead.id} qualify_failed attempt ${attempt}/3, retry at ${retryAt}`,
        );
      }
    }
  }

  if (fitScores.length > 0) {
    summary.avg_fit_score =
      fitScores.reduce((sum, score) => sum + score, 0) / fitScores.length;
  }

  return summary;
}
