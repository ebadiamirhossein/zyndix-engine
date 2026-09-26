// Research runner (09 §UR). For a batch of leads: plan every enabled source
// (reuse, cost cap), run the planned Apify actors in parallel, parse their
// items into typed evidence and upsert it into evidence_items, accounting
// every decision in research_runs.
//
// Rules:
// - research_policy missing, invalid or disabled → return, zero Apify calls.
// - Company-level sources run at most once per company per batch; a later
//   lead (same batch, or within reuse_days) records a `reused` row instead.
//   Person-level sources are reused per lead within reuse_days too (an
//   enrich retry never pays twice for the same lead).
// - Per-lead cost cap: each run's worst case (price table, bounded by its
//   maxTotalChargeUsd) is added to the lead's running total; a run that
//   would exceed max_cost_usd_per_lead is recorded `skipped_cap`, not run.
// - Every run passes maxTotalChargeUsd (= the source's max_charge_usd) and
//   maxItems as Apify run options.
// - A failed or empty run writes zero evidence and a note — missing
//   information, never evidence of a problem.
// - Nothing here throws for a provider or parse failure; enrich wraps the
//   whole call as well, so research can never fail the enrich stage.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApifyClient, ApifyRunOptions } from "@/lib/integrations/apify";
import { apifyActorTemplatesSchema, researchPolicySchema, type ApifyActorTemplates, type ResearchPolicy } from "@/lib/validation/jsonb";
import type { Json } from "@/types/database";
import type { DatabaseWithWave1 } from "@/types/database-extensions";
import type { EvidenceSourceType, ResearchRunStatus } from "@/types/enums";

import { capExposureUsd, estimateActualCostUsd, estimateMaxCostUsd, RESEARCH_PRICES } from "./prices";
import { chargedItemCount, RESEARCH_ADAPTERS, sanitizeActorInput, templateFor } from "./sources";
import { contentHash } from "./text";
import type { DropReason, ResearchTarget, SourceAdapter, SourcePolicy } from "./types";

/** The three Apify calls the runner makes (mocked in tests). */
export type ResearchApify = Pick<ApifyClient, "startRun" | "waitForRun" | "getDatasetItems">;

export type ResearchRunnerDeps = {
  db: SupabaseClient<DatabaseWithWave1>;
  apify: ResearchApify;
  getActiveSetting: (key: string) => Promise<{ version?: number; value: unknown }>;
  now?: () => Date;
};

/** What enrich needs back for the legacy `apify_li_posts` payload. */
export type PersonPostsOutcome = { ok: true; items: Record<string, unknown>[] } | { ok: false; error: string };

export type LeadResearchOutcome = {
  /** source → run status, or a short reason it did not run. */
  sources: Partial<Record<EvidenceSourceType, string>>;
  notes: string[];
  est_cost_usd: number;
  unknown_cost_runs: number;
  person_posts?: PersonPostsOutcome;
};

export type ResearchSummary = {
  enabled: boolean;
  reason: string | null;
  apify_calls: number;
  runs: number;
  succeeded: number;
  empty: number;
  failed: number;
  reused: number;
  skipped_cap: number;
  evidence_upserted: number;
  /** Sum of the known per-run estimates; runs with an unknown price are counted in unknown_cost_runs. */
  est_cost_usd: number;
  unknown_cost_runs: number;
  leads: Record<string, LeadResearchOutcome>;
};

type PolicyLoad = { policy: ResearchPolicy | null; reason: string | null };

/** research_policy, or null with the reason (a missing row = research disabled). Never throws. */
export async function loadResearchPolicy(getActiveSetting: ResearchRunnerDeps["getActiveSetting"]): Promise<PolicyLoad> {
  let value: unknown;
  try {
    value = (await getActiveSetting("research_policy")).value;
  } catch (error) {
    return { policy: null, reason: `research_policy unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = researchPolicySchema.safeParse(value);
  if (!parsed.success) return { policy: null, reason: "research_policy invalid" };
  if (!parsed.data.enabled) return { policy: parsed.data, reason: "research_policy.enabled=false" };
  return { policy: parsed.data, reason: null };
}

/** True when the research person-posts source replaces enrich's legacy li_posts run. */
export function researchCoversPersonPosts(policy: ResearchPolicy | null): boolean {
  return Boolean(policy?.enabled && policy.sources.li_person_post.enabled);
}

type PlannedRun = {
  target: ResearchTarget;
  adapter: SourceAdapter;
  source: SourcePolicy;
  actorId: string;
  input: Record<string, unknown>;
  options: Required<ApifyRunOptions>;
  estimate: number | null;
  priceKnown: boolean;
  // filled by execute
  rowId?: string;
  status?: ResearchRunStatus;
  items?: Record<string, unknown>[];
  upserted?: number;
  error?: string;
};

type BatchReuse = { target: ResearchTarget; run: PlannedRun };

function emptySummary(reason: string | null, enabled: boolean): ResearchSummary {
  return {
    enabled,
    reason,
    apify_calls: 0,
    runs: 0,
    succeeded: 0,
    empty: 0,
    failed: 0,
    reused: 0,
    skipped_cap: 0,
    evidence_upserted: 0,
    est_cost_usd: 0,
    unknown_cost_runs: 0,
    leads: {},
  };
}

function round5(n: number): number {
  return Math.round(n * 100_000) / 100_000;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}

function formatDrops(drops: Partial<Record<DropReason, number>>): string {
  const parts = Object.entries(drops).map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? ` (dropped: ${parts.join(", ")})` : "";
}

export async function runResearchForLeads(deps: ResearchRunnerDeps, targets: ResearchTarget[]): Promise<ResearchSummary> {
  const { policy, reason } = await loadResearchPolicy(deps.getActiveSetting);
  if (!policy || !policy.enabled) return emptySummary(reason, false);

  const summary = emptySummary(null, true);
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();

  let templates: Partial<ApifyActorTemplates> | null = null;
  try {
    const parsed = apifyActorTemplatesSchema.safeParse((await deps.getActiveSetting("apify_actor_templates")).value);
    templates = parsed.success ? parsed.data : null;
  } catch {
    templates = null;
  }

  const outcome = (leadId: string): LeadResearchOutcome => {
    summary.leads[leadId] ??= { sources: {}, notes: [], est_cost_usd: 0, unknown_cost_runs: 0 };
    return summary.leads[leadId]!;
  };

  const planned: PlannedRun[] = [];
  const batchCompanyRuns = new Map<string, PlannedRun>();
  const batchReuses: BatchReuse[] = [];
  const reuseCutoff = new Date(now.getTime() - policy.reuse_days * 86_400_000).toISOString();

  // ---- Plan (sequential, deterministic: lead order, then adapter order) ----
  for (const target of targets) {
    const lead = outcome(target.leadId);
    let exposure = 0;
    for (const adapter of RESEARCH_ADAPTERS) {
      const sourceType = adapter.sourceType;
      const source = policy.sources[sourceType];
      if (!source.enabled) {
        lead.sources[sourceType] = "source_disabled";
        continue;
      }
      const missing = adapter.missingInput(target);
      if (missing) {
        lead.sources[sourceType] = "no_input";
        lead.notes.push(`${sourceType}: not researched — ${missing}`);
        continue;
      }
      const template = templateFor(adapter, templates);
      if (!template) {
        lead.sources[sourceType] = "no_template";
        lead.notes.push(`${sourceType}: not researched — no apify_actor_templates entry (${adapter.templateKeys.join(" / ")})`);
        continue;
      }

      if (adapter.scope === "company") {
        const inBatch = batchCompanyRuns.get(`${target.companyId}:${sourceType}`);
        if (inBatch) {
          batchReuses.push({ target, run: inBatch });
          lead.sources[sourceType] = "reused";
          continue;
        }
      }
      // Reuse a fresh run: company-level by company, person-level by lead
      // (an enrich retry must not pay for the same lead's research twice).
      let freshQuery = deps.db
        .from("research_runs")
        .select("id, actor_id, item_count, finished_at")
        .eq("source_type", sourceType)
        .in("status", ["succeeded", "empty"])
        .gte("finished_at", reuseCutoff);
      freshQuery = adapter.scope === "company" ? freshQuery.eq("company_id", target.companyId) : freshQuery.eq("lead_id", target.leadId);
      const { data: fresh, error: freshError } = await freshQuery
        .order("finished_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (freshError) {
        lead.sources[sourceType] = "failed";
        lead.notes.push(`${sourceType}: reuse lookup failed (${freshError.message}); not researched`);
        continue;
      }
      if (fresh) {
        await insertRun(deps, {
          company_id: target.companyId,
          lead_id: target.leadId,
          source_type: sourceType,
          actor_id: fresh.actor_id,
          status: "reused",
          reused_run_id: fresh.id,
          item_count: fresh.item_count,
          est_cost_usd: 0,
          started_at: nowIso,
          finished_at: nowIso,
        });
        summary.reused += 1;
        lead.sources[sourceType] = "reused";
        continue;
      }

      const price = RESEARCH_PRICES[sourceType];
      const priceKnown = price !== null && price.actorId === template.actor_id;
      const maxItems = adapter.maxItems(source);
      const estimate = priceKnown ? estimateMaxCostUsd(sourceType, maxItems) : null;
      if (priceKnown && price?.minMaxTotalChargeUsd !== undefined && source.max_charge_usd < price.minMaxTotalChargeUsd) {
        lead.sources[sourceType] = "max_charge_below_actor_minimum";
        lead.notes.push(
          `${sourceType}: not researched — max_charge_usd ${source.max_charge_usd} is below the actor's minimalMaxTotalChargeUsd ${price.minMaxTotalChargeUsd}`,
        );
        continue;
      }
      const runExposure = capExposureUsd(estimate, source.max_charge_usd);
      if (exposure + runExposure > policy.max_cost_usd_per_lead + 1e-9) {
        await insertRun(deps, {
          company_id: target.companyId,
          lead_id: target.leadId,
          source_type: sourceType,
          actor_id: template.actor_id,
          status: "skipped_cap",
          item_count: 0,
          est_cost_usd: 0,
          max_charge_usd: source.max_charge_usd,
          error: `would exceed max_cost_usd_per_lead: ${round5(exposure)} + ${round5(runExposure)} > ${policy.max_cost_usd_per_lead}`,
          started_at: nowIso,
          finished_at: nowIso,
        });
        summary.skipped_cap += 1;
        lead.sources[sourceType] = "skipped_cap";
        lead.notes.push(`${sourceType}: skipped — lead cost cap ${policy.max_cost_usd_per_lead} (spent ${round5(exposure)}, run up to ${round5(runExposure)})`);
        continue;
      }
      exposure += runExposure;

      const { input, removed } = sanitizeActorInput(adapter.buildInput(target, source, template.input));
      if (removed.length > 0) lead.notes.push(`${sourceType}: removed credential-like template keys: ${removed.join(", ")}`);
      const run: PlannedRun = {
        target,
        adapter,
        source,
        actorId: template.actor_id,
        input,
        options: { maxItems, maxTotalChargeUsd: source.max_charge_usd },
        estimate,
        priceKnown,
      };
      planned.push(run);
      if (adapter.scope === "company") batchCompanyRuns.set(`${target.companyId}:${sourceType}`, run);
    }
  }

  // ---- Execute (parallel) ----
  await Promise.all(planned.map((run) => executeRun(deps, run, policy, now, summary)));

  for (const run of planned) {
    const lead = outcome(run.target.leadId);
    lead.sources[run.adapter.sourceType] = run.status ?? "failed";
    if (run.adapter.sourceType === "li_person_post") {
      lead.person_posts =
        run.status === "succeeded" || run.status === "empty"
          ? { ok: true, items: run.items ?? [] }
          : { ok: false, error: `research_failed: ${run.error ?? "unknown"}` };
    }
  }

  // ---- Same-batch company reuse (after the one run finished) ----
  for (const { target, run } of batchReuses) {
    const lead = outcome(target.leadId);
    const sourceType = run.adapter.sourceType;
    if ((run.status === "succeeded" || run.status === "empty") && run.rowId) {
      await insertRun(deps, {
        company_id: target.companyId,
        lead_id: target.leadId,
        source_type: sourceType,
        actor_id: run.actorId,
        status: "reused",
        reused_run_id: run.rowId,
        item_count: run.upserted ?? 0,
        est_cost_usd: 0,
        started_at: nowIso,
        finished_at: new Date().toISOString(),
      });
      summary.reused += 1;
      lead.sources[sourceType] = "reused";
    } else {
      lead.sources[sourceType] = "company_run_failed";
      lead.notes.push(`research_failed: ${sourceType}: the company's run in this batch failed; not retried for this contact`);
    }
  }

  // Person-posts outcome for leads whose source did not run.
  for (const target of targets) {
    const lead = outcome(target.leadId);
    if (!lead.person_posts) {
      lead.person_posts = { ok: false, error: `research_${lead.sources.li_person_post ?? "not_run"}` };
    }
  }

  // One audit event per lead: what each source did, and every note.
  for (const target of targets) {
    const lead = outcome(target.leadId);
    const { error } = await deps.db.from("lead_events").insert({
      lead_id: target.leadId,
      event: "research_completed",
      detail: {
        sources: lead.sources,
        notes: lead.notes,
        est_cost_usd: round5(lead.est_cost_usd),
        unknown_cost_runs: lead.unknown_cost_runs,
      } as unknown as Json,
    });
    if (error) console.error(`[research] lead_events insert failed for ${target.leadId}: ${error.message}`);
  }

  summary.est_cost_usd = round5(summary.est_cost_usd);
  return summary;
}

type RunRowInsert = DatabaseWithWave1["public"]["Tables"]["research_runs"]["Insert"];

async function insertRun(deps: ResearchRunnerDeps, row: RunRowInsert): Promise<string | null> {
  const { data, error } = await deps.db.from("research_runs").insert(row).select("id").single();
  if (error || !data) {
    console.error(`[research] research_runs insert failed (${row.source_type}/${row.status}): ${error?.message ?? "no row"}`);
    return null;
  }
  return data.id;
}

async function executeRun(
  deps: ResearchRunnerDeps,
  run: PlannedRun,
  policy: ResearchPolicy,
  now: Date,
  summary: ResearchSummary,
): Promise<void> {
  const sourceType = run.adapter.sourceType;
  const lead = summary.leads[run.target.leadId]!;
  run.rowId =
    (await insertRun(deps, {
      company_id: run.target.companyId,
      lead_id: run.target.leadId,
      source_type: sourceType,
      actor_id: run.actorId,
      status: "running",
      item_count: 0,
      est_cost_usd: run.estimate,
      max_charge_usd: run.options.maxTotalChargeUsd,
      started_at: new Date().toISOString(),
    })) ?? undefined;
  if (!run.rowId) {
    // No accounting row → do not spend.
    run.status = "failed";
    run.error = "research_runs row could not be written; run not started";
    summary.failed += 1;
    lead.notes.push(`research_failed: ${sourceType}: ${run.error}`);
    return;
  }

  const update = async (patch: DatabaseWithWave1["public"]["Tables"]["research_runs"]["Update"]) => {
    const { error } = await deps.db.from("research_runs").update(patch).eq("id", run.rowId!);
    if (error) console.error(`[research] research_runs update failed (${run.rowId}): ${error.message}`);
  };

  summary.runs += 1;
  try {
    summary.apify_calls += 1;
    const apifyRunId = await deps.apify.startRun(run.actorId, run.input, run.options);
    await update({ apify_run_id: apifyRunId });
    const result = await deps.apify.waitForRun(apifyRunId);
    if (result.status !== "SUCCEEDED") {
      throw new Error(`Apify run ${apifyRunId} ended with status ${result.status}`);
    }
    const items = result.defaultDatasetId ? await deps.apify.getDatasetItems(result.defaultDatasetId) : [];
    run.items = items;

    const parsed = run.adapter.parse(items, { target: run.target, now, maxItemAgeDays: policy.max_item_age_days });
    const fetchedAt = new Date().toISOString();
    let upserted = 0;
    if (parsed.candidates.length > 0) {
      const rows = parsed.candidates.map((c) => ({
        company_id: run.target.companyId,
        lead_id: run.adapter.scope === "lead" ? run.target.leadId : null,
        research_run_id: run.rowId!,
        source_type: c.source_type,
        source_url: c.source_url,
        title: c.title,
        excerpt: c.excerpt,
        published_at: c.published_at,
        fetched_at: fetchedAt,
        actor_id: run.actorId,
        content_hash: contentHash(c.excerpt),
        label: "observed" as const,
        raw: c.raw as unknown as Json,
      }));
      // The same item fetched again is one row: the upsert refreshes fetched_at (dedupe key in 0010b).
      const { data, error } = await deps.db
        .from("evidence_items")
        .upsert(rows, { onConflict: "company_id,source_type,source_url,content_hash" })
        .select("id");
      if (error) throw new Error(`evidence_items upsert failed: ${error.message}`);
      upserted = data?.length ?? 0;
    }

    const actual = run.priceKnown ? estimateActualCostUsd(sourceType, chargedItemCount(sourceType, items)) : null;
    run.status = items.length === 0 ? "empty" : "succeeded";
    run.upserted = upserted;
    await update({
      status: run.status,
      item_count: upserted,
      est_cost_usd: actual,
      finished_at: new Date().toISOString(),
      error: null,
    });
    summary.evidence_upserted += upserted;
    if (run.status === "empty") {
      summary.empty += 1;
      lead.notes.push(`research_empty: ${sourceType}: the actor returned nothing (missing information, not evidence)`);
    } else {
      summary.succeeded += 1;
      if (upserted === 0) lead.notes.push(`${sourceType}: ${items.length} item(s), none usable${formatDrops(parsed.drops)}`);
      else if (Object.keys(parsed.drops).length > 0) lead.notes.push(`${sourceType}: kept ${upserted}${formatDrops(parsed.drops)}`);
    }
    for (const note of parsed.notes) lead.notes.push(`${sourceType}: ${note}`);
    if (actual === null) {
      lead.unknown_cost_runs += 1;
      summary.unknown_cost_runs += 1;
    } else {
      lead.est_cost_usd += actual;
      summary.est_cost_usd += actual;
    }
  } catch (error) {
    run.status = "failed";
    run.error = errorText(error);
    run.items = undefined;
    summary.failed += 1;
    // The charge of a failed run is unknown (it may have started): null, never 0.
    await update({ status: "failed", error: run.error, est_cost_usd: null, item_count: 0, finished_at: new Date().toISOString() });
    lead.unknown_cost_runs += 1;
    summary.unknown_cost_runs += 1;
    lead.notes.push(`research_failed: ${sourceType}: ${run.error} (missing information, not evidence)`);
  }
}
