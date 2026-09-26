// Loads everything the claim guard judges against (09 §U6b), for one lead.
// The draft stage and approval both use it, so a draft is judged identically
// when written and when approved (Telegram approve or edit).

import type { SupabaseClient } from "@supabase/supabase-js";

import { getApprovedOfferLines } from "@/lib/settings/cta";
import { getSegmentProofPoint } from "@/lib/settings/proof";
import type { Claim } from "@/lib/validation/llm";
import { ctaVariantsSchema, evidencePolicySchema, proofPointsSchema } from "@/lib/validation/jsonb";
import type { Database } from "@/types/database";

import {
  checkClaims,
  detectContradictions,
  splitComplianceFooter,
  type ClaimCheckResult,
  type ClaimEvidence,
  type Contradiction,
  type TechSignals,
} from "./claims";

export type ClaimContext = {
  evidence: ClaimEvidence[];
  siteText: string | null;
  techSignals: TechSignals;
  evidenceFetchedAt: string | null;
  maxAgeDays: number;
  evidencePolicyVersion: number;
  approvedOfferLines: string[];
  proofPoint: string | null;
  allowNames: string[];
  visibleTools: string[];
  contradictions: Contradiction[];
  contextTexts: string[];
  complianceFooter: string | null;
};

type GetSetting = (key: string) => Promise<{ version: number; value: unknown }>;

/**
 * Interim evidence ids (until U15): E1…En index the lead's
 * qualification.evidence items that carry an observation, in stored order.
 * The writer sees exactly these ids.
 */
export function toClaimEvidence(value: unknown): ClaimEvidence[] {
  if (!Array.isArray(value)) return [];
  const items = value.filter(
    (item): item is { observation: string; source?: unknown } =>
      typeof item === "object" && item !== null && typeof (item as { observation?: unknown }).observation === "string",
  );
  return items.map((item, i) => ({
    id: `E${i + 1}`,
    source: typeof item.source === "string" ? item.source : null,
    observation: item.observation,
  }));
}

function isErrorPayload(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) && "error" in payload;
}

function siteTextOf(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null;
  const parts: string[] = [];
  for (const page of payload) {
    if (typeof page !== "object" || page === null) continue;
    const record = page as Record<string, unknown>;
    const text =
      (typeof record.markdown === "string" && record.markdown) || (typeof record.text === "string" && record.text) || "";
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function loadClaimContext(
  db: SupabaseClient<Database>,
  getActiveSetting: GetSetting,
  leadId: string,
): Promise<ClaimContext> {
  const [{ data: lead, error: leadError }, { data: qualification }, { data: payloads, error: payloadError }] =
    await Promise.all([
      db.from("leads").select("id, first_name, last_name, companies(name, domain)").eq("id", leadId).maybeSingle(),
      db
        .from("qualification")
        .select("evidence, visible_tools, problem_hypothesis, segment")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("enrichment_payloads")
        .select("source, payload, fetched_at")
        .eq("lead_id", leadId)
        .order("fetched_at", { ascending: false }),
    ]);
  if (leadError) throw new Error(`claim context: lead ${leadId}: ${leadError.message}`);
  if (payloadError) throw new Error(`claim context: enrichment for ${leadId}: ${payloadError.message}`);
  if (!lead) throw new Error(`claim context: lead ${leadId} not found`);

  const [policySetting, ctaSetting, proofSetting, footerSetting] = await Promise.all([
    getActiveSetting("evidence_policy"),
    getActiveSetting("cta_variants"),
    getActiveSetting("proof_points"),
    getActiveSetting("compliance_footer"),
  ]);
  const policy = evidencePolicySchema.parse(policySetting.value);
  const cta = ctaVariantsSchema.parse(ctaSetting.value);
  const proofPoints = proofPointsSchema.parse(proofSetting.value);

  const good = (payloads ?? []).filter((row) => !isErrorPayload(row.payload));
  const site = good.find((row) => row.source === "apify_site");
  const tech = good.find((row) => row.source === "apify_tech");
  const techPayload = tech?.payload as { signals?: Record<string, unknown> } | null | undefined;
  const techSignals = techPayload?.signals && typeof techPayload.signals === "object" ? techPayload.signals : null;
  const siteText = site ? siteTextOf(site.payload) : null;

  const evidence = toClaimEvidence(qualification?.evidence);
  const company = lead.companies as { name: string; domain: string | null } | null;

  return {
    evidence,
    siteText,
    techSignals,
    evidenceFetchedAt: good[0]?.fetched_at ?? null,
    maxAgeDays: policy.max_age_days,
    evidencePolicyVersion: policySetting.version,
    approvedOfferLines: getApprovedOfferLines(cta),
    proofPoint: getSegmentProofPoint(proofPoints, qualification?.segment ?? "us-realestate"),
    allowNames: [lead.first_name, lead.last_name, company?.name, company?.domain, "Zyndix"].filter(
      (name): name is string => typeof name === "string" && name.trim().length > 0,
    ),
    visibleTools: asStringArray(qualification?.visible_tools),
    contradictions: detectContradictions({ evidence, techSignals, siteText }),
    contextTexts: [qualification?.problem_hypothesis ?? ""].filter(Boolean),
    complianceFooter: typeof footerSetting.value === "string" ? footerSetting.value : null,
  };
}

/** Per-step options (09 §U6c): template mode, freshness offset, step label. */
export type ClaimStepOptions = { mode?: "writer" | "template"; offsetDays?: number; stepNo?: number };

/** Runs the guard on exactly this subject and body (the footer is stripped first). */
export function runClaimCheck(
  ctx: ClaimContext,
  draft: { subject: string; body: string; claims: Claim[] },
  now: Date = new Date(),
  step: ClaimStepOptions = {},
): ClaimCheckResult {
  const { content } = splitComplianceFooter(draft.body, ctx.complianceFooter);
  return checkClaims({
    subject: draft.subject,
    body: content,
    claims: draft.claims,
    evidence: ctx.evidence,
    siteText: ctx.siteText,
    evidenceFetchedAt: ctx.evidenceFetchedAt,
    now,
    maxAgeDays: ctx.maxAgeDays,
    approvedOfferLines: ctx.approvedOfferLines,
    proofPoint: ctx.proofPoint,
    allowNames: ctx.allowNames,
    visibleTools: ctx.visibleTools,
    contradictions: ctx.contradictions,
    contextTexts: ctx.contextTexts,
    mode: step.mode,
    offsetDays: step.offsetDays,
    stepNo: step.stepNo,
  });
}
