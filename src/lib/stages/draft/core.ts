import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import type { AnthropicClient } from "@/lib/integrations/anthropic";
import { parseJsonText } from "@/lib/integrations/anthropic";
import type { TelegramClient } from "@/lib/integrations/telegram";
import { ensureDefaultSequence } from "@/lib/sequences/default";
import {
  appendComplianceFooter,
  interpolateComplianceFooter,
} from "@/lib/settings/compliance";
import {
  getActiveCtaText,
  interpolateWriterPrompt,
} from "@/lib/settings/cta";
import { findSignOff } from "@/lib/sending/approval";
import { getSegmentProofPoint } from "@/lib/settings/proof";
import { createStateStore } from "@/lib/state/core";
import type {
  cadenceDefaultSchema,
  ctaVariantsSchema,
  proofPointsSchema,
} from "@/lib/validation/jsonb";
import { writerOutputSchema } from "@/lib/validation/llm";
import type { Database } from "@/types/database";

import { checkGenericDraft, wordCount } from "./guard";

type WriterOutput = z.infer<typeof writerOutputSchema>;
type CadenceDefault = z.infer<typeof cadenceDefaultSchema>;
type CtaVariants = z.infer<typeof ctaVariantsSchema>;
type ProofPoints = z.infer<typeof proofPointsSchema>;

export type DraftStageSummary = {
  leads_picked: number;
  drafted: number;
  generic_rejected: number;
  parked_generic: number;
  failed: number;
  tokens_used: number;
  est_cost_usd: number;
};

type DraftDeps = {
  db: SupabaseClient<Database>;
  anthropic: AnthropicClient;
  telegram: TelegramClient;
  getActiveSetting: (key: string) => Promise<{ version: number; value: unknown }>;
  transition: ReturnType<typeof createStateStore>["transition"];
};

type LeadPick = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  email_status: string | null;
  current_sequence_id: string | null;
  company: {
    name: string;
    domain: string | null;
    country: string | null;
  };
  qualification: {
    fit_score: number | null;
    segment: string | null;
    problem_hypothesis: string;
    evidence: unknown;
    triggers: unknown;
    visible_tools: unknown;
    recommended_angle: string | null;
  };
};

function draftBatchSize(): number {
  const raw = process.env.DRAFT_BATCH_SIZE ?? "5";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function draftTemperature(): number {
  const raw = process.env.DRAFT_TEMPERATURE ?? "0.7";
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0.7;
}

function defaultAnthropicModel(): string {
  return process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
}

async function resolveModel(
  getActiveSetting: DraftDeps["getActiveSetting"],
): Promise<string> {
  try {
    const setting = await getActiveSetting("anthropic_model");
    if (typeof setting.value === "string" && setting.value.trim()) {
      return setting.value.trim();
    }
  } catch {
    // optional setting
  }
  return defaultAnthropicModel();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asEvidence(value: unknown): { observation: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is { observation: string } =>
        typeof item === "object" &&
        item !== null &&
        "observation" in item &&
        typeof (item as { observation: unknown }).observation === "string",
    )
    .map((item) => ({ observation: item.observation }));
}

function buildWriterInput(
  lead: LeadPick,
  cadenceStep: CadenceDefault["steps"][number],
  proofPoint: string | null,
): Record<string, unknown> {
  return {
    qualification: {
      problem_hypothesis: lead.qualification.problem_hypothesis,
      evidence: asEvidence(lead.qualification.evidence),
      recommended_angle: lead.qualification.recommended_angle,
      visible_tools: asStringArray(lead.qualification.visible_tools),
      triggers: asStringArray(lead.qualification.triggers),
      fit_score: lead.qualification.fit_score,
      segment: lead.qualification.segment,
    },
    lead: {
      first_name: lead.first_name,
      title: lead.title,
      company_name: lead.company.name,
      domain: lead.company.domain,
    },
    proof_point: proofPoint,
    cadence_step: {
      step: cadenceStep.step,
      wait_days: cadenceStep.wait_days,
      channel: cadenceStep.channel,
      hint: cadenceStep.hint,
      requires_approval: cadenceStep.requires_approval,
    },
    geo: {
      country: lead.company.country,
    },
  };
}

function normalizeWriterRaw(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  return {
    subject: obj.subject,
    body: obj.body,
  };
}

function isWordCountSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("issues" in error)) {
    return false;
  }
  const issues = (error as { issues: { message?: string; path?: unknown[] }[] })
    .issues;
  return issues.some(
    (issue) =>
      issue.path?.includes("body") &&
      typeof issue.message === "string" &&
      issue.message.includes("≤120 words"),
  );
}

async function writeDraftWithGuard(
  deps: DraftDeps,
  lead: LeadPick,
  systemPrompt: string,
  model: string,
  writerInput: Record<string, unknown>,
  proofPoint: string | null,
  complianceFooter: string,
  ctaText: string,
): Promise<
  | { ok: true; output: WriterOutput; tokens: number; cost: number }
  | { ok: false; rejections: string[] }
> {
  const rejections: string[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  let wordCountRetryHint: string | null = null;
  let guardRetryHint: string | null = null;
  let signOffRetryHint: string | null = null;
  const evidence = asEvidence(lead.qualification.evidence);

  const numberSourceTexts = [
    lead.qualification.problem_hypothesis,
    ...evidence.map((item) => item.observation),
    proofPoint ?? "",
    ctaText,
    lead.company.name,
    lead.company.domain ?? "",
    lead.title ?? "",
  ].filter(Boolean);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const userParts: string[] = [];
    if (guardRetryHint) {
      userParts.push(guardRetryHint);
    }
    if (wordCountRetryHint) {
      userParts.push(wordCountRetryHint);
    }
    if (signOffRetryHint) {
      userParts.push(signOffRetryHint);
    }
    userParts.push(JSON.stringify(writerInput, null, 2));

    const completion = await deps.anthropic.complete({
      system: systemPrompt,
      user: userParts.join("\n\n"),
      model,
      temperature: draftTemperature(),
      maxTokens: 1024,
    });

    totalTokens += completion.inputTokens + completion.outputTokens;
    totalCost += completion.estCostUsd;

    let raw: unknown;
    try {
      raw = normalizeWriterRaw(parseJsonText(completion.text));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejections.push(`attempt ${attempt}: non-json: ${message.slice(0, 120)}`);
      console.warn(`[draft] non-JSON response for lead ${lead.id}: ${message.slice(0, 120)}`);
      continue;
    }

    const parsed = writerOutputSchema.safeParse(raw);

    if (!parsed.success) {
      const rawBody =
        typeof raw === "object" &&
        raw !== null &&
        "body" in raw &&
        typeof (raw as { body: unknown }).body === "string"
          ? (raw as { body: string }).body
          : "";

      if (isWordCountSchemaError(parsed.error) && !wordCountRetryHint) {
        const count = wordCount(rawBody);
        wordCountRetryHint = [
          `REVISION REQUIRED: your previous body was ${count} words.`,
          "Cut it to ≤120 words.",
          'Return ONLY {"subject":"...","body":"..."} with no other keys.',
        ].join(" ");
        console.warn(
          `[draft] word-count rejection for lead ${lead.id} (${count} words) — retrying`,
        );
        attempt -= 1;
        continue;
      }

      const reason = parsed.error.issues
        .map((issue) => issue.message)
        .join("; ");
      rejections.push(`attempt ${attempt}: schema: ${reason}`);
      console.warn(`[draft] schema rejected lead ${lead.id}: ${reason}`);
      continue;
    }

    const output = parsed.data;

    // writer_prompt_email v8 forbids a sign-off (the mailbox signature is
    // appended at send); approval refuses a self-signed body, so catch it here.
    const signOff = findSignOff(output.body);
    if (signOff) {
      rejections.push(`attempt ${attempt}: signs itself (${JSON.stringify(signOff)})`);
      console.warn(`[draft] sign-off rejection for lead ${lead.id} — ${signOffRetryHint ? "no retry left" : "retrying"}`);
      if (!signOffRetryHint) {
        signOffRetryHint = [
          `REVISION REQUIRED: your previous body ended with a sign-off (${JSON.stringify(signOff)}).`,
          "Do NOT sign off and do NOT write any name at the end; the signature is added separately.",
          'Return ONLY {"subject":"...","body":"..."}.',
        ].join(" ");
        attempt -= 1;
      }
      continue;
    }

    const guard = checkGenericDraft({
      body: output.body,
      problemHypothesis: lead.qualification.problem_hypothesis,
      companyName: lead.company.name,
      companyDomain: lead.company.domain,
      visibleTools: asStringArray(lead.qualification.visible_tools),
      evidence,
      proofPoint,
      numberSourceTexts,
    });

    if (guard.ok) {
      const bodyWithFooter = appendComplianceFooter(output.body, complianceFooter);
      return {
        ok: true,
        output: {
          subject: output.subject,
          body: bodyWithFooter,
        },
        tokens: totalTokens,
        cost: totalCost,
      };
    }

    const reason = guard.reason;
    rejections.push(`attempt ${attempt}: ${reason}`);
    console.warn(
      `[draft] generic guard rejected lead ${lead.id} (${reason})`,
    );

    const isNumberRejection =
      reason.includes("invented number") || reason.includes("invented statistic");
    if (isNumberRejection && !guardRetryHint) {
      const nums =
        "offendingNumbers" in guard && guard.offendingNumbers
          ? guard.offendingNumbers.join(", ")
          : reason;
      guardRetryHint = [
        "REVISION REQUIRED: you used numbers or statistics not in the evidence.",
        `Problem: ${nums}.`,
        "Remove ALL invented numbers, percentages, time thresholds, and stat phrases.",
        "Convey urgency by describing the mechanism only.",
        'Return ONLY {"subject":"...","body":"..."}.',
      ].join(" ");
      attempt -= 1;
    }
  }

  return { ok: false, rejections };
}

async function pickDraftingLeads(
  db: SupabaseClient<Database>,
  limit: number,
  leadIds?: string[],
): Promise<LeadPick[]> {
  let query = db
    .from("leads")
    .select(
      `
      id,
      first_name,
      last_name,
      title,
      email,
      email_status,
      current_sequence_id,
      companies!inner(name, domain, country),
      qualification!inner(
        fit_score,
        segment,
        problem_hypothesis,
        evidence,
        triggers,
        visible_tools,
        recommended_angle
      )
    `,
    )
    .eq("state", "drafting");
  if (leadIds) query = query.in("id", leadIds);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(limit);

  if (error) {
    throw new Error(`Failed to pick drafting leads: ${error.message}`);
  }

  return (data ?? []).map((row) => {
    const company = row.companies as {
      name: string;
      domain: string | null;
      country: string | null;
    };
    const qualificationRaw = row.qualification;
    const qualification = (
      Array.isArray(qualificationRaw) ? qualificationRaw[0] : qualificationRaw
    ) as LeadPick["qualification"];
    return {
      id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      title: row.title,
      email: row.email,
      email_status: row.email_status,
      current_sequence_id: row.current_sequence_id,
      company,
      qualification,
    };
  });
}

export async function runDraftStage(
  deps: DraftDeps,
  options?: {
    limit?: number;
  /** Only these leads (scripts and tests; production passes nothing and picks by state). */
  leadIds?: string[];
  },
): Promise<DraftStageSummary> {
  const limit = options?.limit ?? draftBatchSize();
  const summary: DraftStageSummary = {
    leads_picked: 0,
    drafted: 0,
    generic_rejected: 0,
    parked_generic: 0,
    failed: 0,
    tokens_used: 0,
    est_cost_usd: 0,
  };

  const [writerSetting, cadenceSetting, ctaSetting, proofSetting, footerSetting] =
    await Promise.all([
      deps.getActiveSetting("writer_prompt_email"),
      deps.getActiveSetting("cadence_default"),
      deps.getActiveSetting("cta_variants"),
      deps.getActiveSetting("proof_points"),
      deps.getActiveSetting("compliance_footer"),
    ]);

  const cadence = cadenceSetting.value as CadenceDefault;
  const ctaVariants = ctaSetting.value as CtaVariants;
  const proofPoints = proofSetting.value as ProofPoints;
  const complianceFooter = String(footerSetting.value);
  const cadenceStep =
    cadence.steps.find((step) => step.step === 1) ?? cadence.steps[0]!;
  const promptWithCta = interpolateWriterPrompt(
    String(writerSetting.value),
    getActiveCtaText(ctaVariants),
  );
  const systemPrompt = interpolateComplianceFooter(
    promptWithCta,
    complianceFooter,
  );
  const ctaText = getActiveCtaText(ctaVariants);
  const promptVersion = writerSetting.version;
  const model = await resolveModel(deps.getActiveSetting);

  const leads = await pickDraftingLeads(deps.db, limit, options?.leadIds);
  summary.leads_picked = leads.length;

  for (const lead of leads) {
    try {
      const segmentKey = lead.qualification.segment ?? "us-realestate";
      const proofPoint = getSegmentProofPoint(proofPoints, segmentKey);
      const sequenceId =
        lead.current_sequence_id ??
        (await ensureDefaultSequence(deps.db, cadence, segmentKey));

      if (!lead.current_sequence_id) {
        await deps.db
          .from("leads")
          .update({ current_sequence_id: sequenceId, current_step: 1 })
          .eq("id", lead.id);
      }

      const writerInput = buildWriterInput(lead, cadenceStep, proofPoint);
      const result = await writeDraftWithGuard(
        deps,
        lead,
        systemPrompt,
        model,
        writerInput,
        proofPoint,
        complianceFooter,
        ctaText,
      );

      if (!result.ok) {
        summary.generic_rejected += result.rejections.length;
        await deps.transition(lead.id, "drafting", "parked", "writer_generic_3x", {
          rejections: result.rejections,
          prompt_version: promptVersion,
        });
        summary.parked_generic += 1;
        continue;
      }

      const { output } = result;
      summary.tokens_used += result.tokens;
      summary.est_cost_usd += result.cost;

      const { data: touch, error: touchError } = await deps.db
        .from("touches")
        .insert({
          lead_id: lead.id,
          sequence_id: sequenceId,
          step_no: 1,
          channel: "email",
          direction: "outbound",
          status: "pending_approval",
          subject: output.subject,
          draft_body: output.body,
          body: null,
          prompt_version: promptVersion,
        })
        .select("*")
        .single();

      if (touchError || !touch) {
        throw new Error(
          `Failed to insert touch for ${lead.id}: ${touchError?.message ?? "no row"}`,
        );
      }

      await deps.transition(lead.id, "drafting", "pending_approval", "drafted", {
        touch_id: touch.id,
        subject: output.subject,
        word_count: wordCount(output.body),
        prompt_version: promptVersion,
        model,
      });

      const telegramResult = await deps.telegram.sendApproval(
        touch,
        {
          id: lead.id,
          first_name: lead.first_name,
          last_name: lead.last_name,
          title: lead.title,
          email_status: lead.email_status,
        },
        {
          fit_score: lead.qualification.fit_score,
          segment: lead.qualification.segment,
          problem_hypothesis: lead.qualification.problem_hypothesis,
          evidence: asEvidence(lead.qualification.evidence),
          recommended_angle: lead.qualification.recommended_angle,
        },
        {
          name: lead.company.name,
          domain: lead.company.domain,
        },
      );

      if (telegramResult.failed.length > 0) {
        console.warn(
          `[draft] Telegram delivery failed for lead ${lead.id}:`,
          telegramResult.failed,
        );
      }

      summary.drafted += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`[draft] failed for lead ${lead.id}:`, error);
    }
  }

  return summary;
}
