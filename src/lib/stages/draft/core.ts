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
import { cumulativeOffsetDays, type EmailSequence } from "@/lib/sending/sequence-approval";
import { getSegmentProofPoint } from "@/lib/settings/proof";
import { createStateStore } from "@/lib/state/core";
import {
  emailSequenceSchema,
  followupTemplatesSchema,
  type cadenceDefaultSchema,
  type ctaVariantsSchema,
  type proofPointsSchema,
} from "@/lib/validation/jsonb";
import { sequenceShapeIssues, writerSequenceOutputSchema } from "@/lib/validation/llm";
import type { Database, Json } from "@/types/database";
import type { DatabaseWithSending } from "@/types/database-extensions";

import { loadClaimContext, toClaimEvidence, type ClaimContext } from "./claims-context";
import { checkGenericDraft, wordCount } from "./guard";
import {
  checkSequenceClaims,
  formatRepeatIssues,
  formatStepViolations,
  renderFollowupTemplate,
  sequenceConfigIssues,
  stepsRepeatingStepOne,
  writerStepNos,
  type FollowupTemplates,
  type RepeatIssue,
  type SequenceStepDraft,
  type StepViolations,
} from "./sequence";

type CadenceDefault = z.infer<typeof cadenceDefaultSchema>;
type CtaVariants = z.infer<typeof ctaVariantsSchema>;
type ProofPoints = z.infer<typeof proofPointsSchema>;

export type DraftStageSummary = {
  leads_picked: number;
  drafted: number;
  generic_rejected: number;
  parked_generic: number;
  /** Held by the claim guard (09 §U6b): drafting → manual_hold, no touch written. */
  claim_held: number;
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
  sequence: EmailSequence,
  proofPoint: string | null,
): Record<string, unknown> {
  const offsets = cumulativeOffsetDays(sequence);
  return {
    qualification: {
      problem_hypothesis: lead.qualification.problem_hypothesis,
      // Interim ids E1…En (09 §U6b): the writer cites these in its claims.
      evidence: toClaimEvidence(lead.qualification.evidence),
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
    // 09 §U6c: the writer steps and the day each goes out (step 1 = day 0).
    sequence: sequence.steps
      .filter((step) => step.source === "writer")
      .map((step) => ({ step_no: step.step_no, day: offsets.get(step.step_no) ?? 0 })),
    geo: {
      country: lead.company.country,
    },
  };
}

/**
 * v10 output: keep only the documented keys. A follow-up's empty or null
 * subject is dropped (it means "no subject"); a non-empty one is kept so the
 * shape check refuses it.
 */
function normalizeWriterRaw(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.steps)) return { steps: obj.steps };
  return {
    steps: obj.steps.map((step: unknown) => {
      if (typeof step !== "object" || step === null || Array.isArray(step)) return step;
      const s = step as Record<string, unknown>;
      const subject = typeof s.subject === "string" && s.subject.trim() === "" ? undefined : (s.subject ?? undefined);
      return { step_no: s.step_no, ...(subject === undefined ? {} : { subject }), body: s.body, claims: s.claims };
    }),
  };
}

const RETURN_SHAPE =
  'Return ONLY {"steps":[{"step_no":1,"subject":"...","body":"...","claims":[{"span":"...","kind":"...","evidence_ids":["E1"]}]},{"step_no":2,"body":"...","claims":[...]}]}.';

function wordCountIssueSteps(error: unknown): number[] {
  if (!error || typeof error !== "object" || !("issues" in error)) {
    return [];
  }
  const issues = (error as { issues: { message?: string; path?: unknown[] }[] }).issues;
  const steps = new Set<number>();
  for (const issue of issues) {
    const path = issue.path ?? [];
    if (path[0] === "steps" && typeof path[1] === "number" && path.includes("body") && issue.message?.includes("≤120 words")) {
      steps.add(path[1]);
    }
  }
  return [...steps];
}

type HoldReason = "claim_guard" | "sequence_shape_invalid" | "template_variable_missing" | "step2_repeats_step1";

type SequenceWriteResult =
  | { ok: true; steps: SequenceStepDraft[]; tokens: number; cost: number }
  | {
      ok: false;
      rejections: string[];
      /** Hold (not park): malformed/misshapen output, a missing template variable, or the claim guard refused twice. */
      hold: boolean;
      holdReason?: HoldReason;
      failures?: StepViolations[];
      repeats?: RepeatIssue[];
      lastDraft?: unknown;
      /** Spent on the attempts that were refused (Session 20: holds were reported as $0). */
      tokens: number;
      cost: number;
    };

async function writeSequenceWithGuard(
  deps: DraftDeps,
  lead: LeadPick,
  systemPrompt: string,
  model: string,
  writerInput: Record<string, unknown>,
  proofPoint: string | null,
  complianceFooter: string,
  ctaText: string,
  claimContext: ClaimContext,
  sequence: EmailSequence,
  templates: FollowupTemplates,
): Promise<SequenceWriteResult> {
  const rejections: string[] = [];
  let totalTokens = 0;
  let totalCost = 0;
  let wordCountRetryHint: string | null = null;
  let guardRetryHint: string | null = null;
  let signOffRetryHint: string | null = null;
  let claimRetryHint: string | null = null;
  let shapeRetryHint: string | null = null;
  let repeatRetryHint: string | null = null;
  let lastFailure: "nonjson" | "shape" | "signoff" | "generic" | "claims" | "repeat" | null = null;
  let lastFailures: StepViolations[] | undefined;
  let lastDraft: unknown;
  const evidence = asEvidence(lead.qualification.evidence);
  const expectedWriterSteps = writerStepNos(sequence);

  const numberSourceTexts = [
    lead.qualification.problem_hypothesis,
    ...evidence.map((item) => item.observation),
    proofPoint ?? "",
    ctaText,
    lead.company.name,
    lead.company.domain ?? "",
    lead.title ?? "",
  ].filter(Boolean);

  const shapeHint = (problem: string) =>
    [
      `REVISION REQUIRED (sequence_shape_invalid): ${problem}.`,
      `Return exactly the steps [${expectedWriterSteps.join(", ")}], in order. Only step 1 has a subject; later steps have no subject key.`,
      RETURN_SHAPE,
    ].join(" ");

  for (let attempt = 1; attempt <= 2; attempt++) {
    const userParts: string[] = [];
    for (const hint of [shapeRetryHint, guardRetryHint, wordCountRetryHint, signOffRetryHint, claimRetryHint, repeatRetryHint]) {
      if (hint) userParts.push(hint);
    }
    userParts.push(JSON.stringify(writerInput, null, 2));

    const completion = await deps.anthropic.complete({
      system: systemPrompt,
      user: userParts.join("\n\n"),
      model,
      temperature: draftTemperature(),
      maxTokens: 2048,
    });

    totalTokens += completion.inputTokens + completion.outputTokens;
    totalCost += completion.estCostUsd;

    let raw: unknown;
    try {
      raw = normalizeWriterRaw(parseJsonText(completion.text));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejections.push(`attempt ${attempt}: sequence_shape_invalid: non-json: ${message.slice(0, 120)}`);
      lastFailure = "nonjson";
      console.warn(`[draft] non-JSON response for lead ${lead.id}: ${message.slice(0, 120)}`);
      continue;
    }
    lastDraft = raw;

    const parsed = writerSequenceOutputSchema.safeParse(raw);

    if (!parsed.success) {
      const longSteps = wordCountIssueSteps(parsed.error);
      if (longSteps.length > 0 && !wordCountRetryHint) {
        const rawSteps = (raw as { steps?: { body?: unknown }[] }).steps ?? [];
        const counts = longSteps.map((i) => `step ${i + 1}: ${wordCount(String(rawSteps[i]?.body ?? ""))} words`);
        wordCountRetryHint = [
          `REVISION REQUIRED: body too long (${counts.join(", ")}).`,
          "Cut every body to ≤120 words.",
          RETURN_SHAPE,
        ].join(" ");
        console.warn(`[draft] word-count rejection for lead ${lead.id} (${counts.join(", ")}) — retrying`);
        attempt -= 1;
        continue;
      }

      const reason = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      rejections.push(`attempt ${attempt}: sequence_shape_invalid: ${reason}`);
      lastFailure = "shape";
      console.warn(`[draft] sequence_shape_invalid for lead ${lead.id}: ${reason}`);
      if (!shapeRetryHint) shapeRetryHint = shapeHint(reason.slice(0, 300));
      continue;
    }

    const shapeIssues = sequenceShapeIssues(parsed.data, expectedWriterSteps);
    if (shapeIssues.length > 0) {
      rejections.push(`attempt ${attempt}: sequence_shape_invalid: ${shapeIssues.join("; ")}`);
      lastFailure = "shape";
      console.warn(`[draft] sequence_shape_invalid for lead ${lead.id}: ${shapeIssues.join("; ")}`);
      if (!shapeRetryHint) shapeRetryHint = shapeHint(shapeIssues.join("; "));
      continue;
    }

    const writerSteps = parsed.data.steps;

    // writer_prompt_email v8+ forbids a sign-off (the mailbox signature is
    // appended at send); approval refuses a self-signed body, so catch it here.
    const signed = writerSteps
      .map((step) => ({ step: step.step_no, signOff: findSignOff(step.body) }))
      .filter((x): x is { step: number; signOff: string } => x.signOff !== null);
    if (signed.length > 0) {
      const what = signed.map((x) => `step ${x.step} (${JSON.stringify(x.signOff)})`).join(", ");
      rejections.push(`attempt ${attempt}: signs itself: ${what}`);
      lastFailure = "signoff";
      console.warn(`[draft] sign-off rejection for lead ${lead.id} — ${signOffRetryHint ? "no retry left" : "retrying"}`);
      if (!signOffRetryHint) {
        signOffRetryHint = [
          `REVISION REQUIRED: these bodies ended with a sign-off: ${what}.`,
          "Do NOT sign off and do NOT write any name at the end; the signature is added separately.",
          RETURN_SHAPE,
        ].join(" ");
        attempt -= 1;
      }
      continue;
    }

    let genericFailure: { step: number; reason: string; offendingNumbers?: string[] } | null = null;
    for (const step of writerSteps) {
      const guard = checkGenericDraft({
        body: step.body,
        problemHypothesis: lead.qualification.problem_hypothesis,
        companyName: lead.company.name,
        companyDomain: lead.company.domain,
        visibleTools: asStringArray(lead.qualification.visible_tools),
        evidence,
        proofPoint,
        numberSourceTexts,
      });
      if (!guard.ok) {
        genericFailure = { step: step.step_no, reason: guard.reason, offendingNumbers: guard.offendingNumbers };
        break;
      }
    }

    if (genericFailure) {
      const reason = `step ${genericFailure.step}: ${genericFailure.reason}`;
      rejections.push(`attempt ${attempt}: ${reason}`);
      lastFailure = "generic";
      console.warn(`[draft] generic guard rejected lead ${lead.id} (${reason})`);

      const isNumberRejection =
        genericFailure.reason.includes("invented number") || genericFailure.reason.includes("invented statistic");
      if (isNumberRejection && !guardRetryHint) {
        const nums = genericFailure.offendingNumbers?.join(", ") ?? genericFailure.reason;
        guardRetryHint = [
          `REVISION REQUIRED: step ${genericFailure.step} used numbers or statistics not in the evidence.`,
          `Problem: ${nums}.`,
          "Remove ALL invented numbers, percentages, time thresholds, and stat phrases.",
          "Convey urgency by describing the mechanism only.",
          RETURN_SHAPE,
        ].join(" ");
        attempt -= 1;
      }
      continue;
    }

    // Assemble every step of the sequence: writer steps, then template steps.
    // The compliance footer goes on every step (each is its own email).
    const steps: SequenceStepDraft[] = [];
    for (const spec of sequence.steps) {
      if (spec.source === "writer") {
        const w = writerSteps.find((step) => step.step_no === spec.step_no)!;
        steps.push({
          step_no: spec.step_no,
          source: "writer",
          subject: spec.step_no === 1 ? (w.subject ?? "").trim() : null,
          body: appendComplianceFooter(w.body, complianceFooter),
          claims: w.claims,
        });
        continue;
      }
      const template = templates.templates.find((t) => t.step_no === spec.step_no)!;
      const text = renderFollowupTemplate(template.body, { first_name: lead.first_name });
      if (text === null) {
        rejections.push(`step ${spec.step_no}: template_variable_missing: {first_name} has no value`);
        return { ok: false, rejections, hold: true, holdReason: "template_variable_missing", lastDraft: raw, tokens: totalTokens, cost: totalCost };
      }
      steps.push({
        step_no: spec.step_no,
        source: "template",
        subject: null,
        body: appendComplianceFooter(text, complianceFooter),
        claims: [],
      });
    }

    // Claim guard (09 §U6b, per step 09 §U6c): deterministic, on the pre-footer text.
    const claimCheck = checkSequenceClaims(claimContext, steps, sequence);
    if (claimCheck.ok) {
      // 09 §U6c S20: a follow-up must cite evidence step 1 does not (a new
      // angle, not step 1's observation again). One revision retry, then hold.
      const repeats = stepsRepeatingStepOne(steps);
      if (repeats.length === 0) {
        return { ok: true, steps, tokens: totalTokens, cost: totalCost };
      }
      const repeatLines = formatRepeatIssues(repeats);
      rejections.push(`attempt ${attempt}: ${repeatLines.join(" | ")}`);
      lastFailure = "repeat";
      console.warn(`[draft] step2_repeats_step1 for lead ${lead.id} — ${repeatRetryHint ? "holding" : "retrying"}`);
      if (repeatRetryHint) {
        return { ok: false, rejections, hold: true, holdReason: "step2_repeats_step1", repeats, lastDraft: raw, tokens: totalTokens, cost: totalCost };
      }
      repeatRetryHint = [
        "REVISION REQUIRED (step2_repeats_step1): a follow-up repeated step 1's evidence:",
        ...repeatLines.map((line) => `- ${line}`),
        "Step 2 must take a new angle: cite at least one evidence item that step 1 does not cite.",
        RETURN_SHAPE,
      ].join("\n");
      attempt -= 1;
      continue;
    }

    const lines = formatStepViolations(claimCheck.failures);
    rejections.push(`attempt ${attempt}: claim guard: ${lines.join(" | ")}`);
    lastFailure = "claims";
    lastFailures = claimCheck.failures;
    // A refused template step cannot be fixed by the writer: hold at once.
    const writerCanFix = claimCheck.failures.some((f) => sequence.steps.find((s) => s.step_no === f.step)?.source === "writer");
    console.warn(`[draft] claim guard rejected lead ${lead.id} — ${claimRetryHint || !writerCanFix ? "holding" : "retrying"}`);
    if (claimRetryHint || !writerCanFix) {
      return { ok: false, rejections, hold: true, holdReason: "claim_guard", failures: claimCheck.failures, lastDraft: raw, tokens: totalTokens, cost: totalCost };
    }
    claimRetryHint = [
      "REVISION REQUIRED: the claim guard refused your draft:",
      ...lines.map((line) => `- ${line}`),
      "Fix every item. Remove any fact you cannot cite; never state weekdays or times of day;",
      "never say you have prepared or mapped out anything; any offer is the approved line verbatim.",
      "Every claim span must be copied verbatim from that step's subject or body.",
      RETURN_SHAPE,
    ].join("\n");
    attempt -= 1;
  }

  if (lastFailure === "claims") {
    return { ok: false, rejections, hold: true, holdReason: "claim_guard", failures: lastFailures, lastDraft, tokens: totalTokens, cost: totalCost };
  }
  if (lastFailure === "repeat") {
    return { ok: false, rejections, hold: true, holdReason: "step2_repeats_step1", lastDraft, tokens: totalTokens, cost: totalCost };
  }
  if (lastFailure === "shape" || lastFailure === "nonjson") {
    return { ok: false, rejections, hold: true, holdReason: "sequence_shape_invalid", lastDraft, tokens: totalTokens, cost: totalCost };
  }
  return { ok: false, rejections, hold: false, tokens: totalTokens, cost: totalCost };
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
    claim_held: 0,
    failed: 0,
    tokens_used: 0,
    est_cost_usd: 0,
  };

  const [writerSetting, cadenceSetting, ctaSetting, proofSetting, footerSetting, sequenceSetting, templatesSetting] =
    await Promise.all([
      deps.getActiveSetting("writer_prompt_email"),
      deps.getActiveSetting("cadence_default"),
      deps.getActiveSetting("cta_variants"),
      deps.getActiveSetting("proof_points"),
      deps.getActiveSetting("compliance_footer"),
      deps.getActiveSetting("email_sequence"),
      deps.getActiveSetting("followup_templates"),
    ]);

  // 09 §U6c: the sequence and its templates must agree before any lead is
  // touched; a mismatch is a configuration error, not a per-lead hold.
  const sequence = emailSequenceSchema.parse(sequenceSetting.value);
  const templates = followupTemplatesSchema.parse(templatesSetting.value);
  const configIssues = sequenceConfigIssues(sequence, templates);
  if (configIssues.length > 0) {
    throw new Error(`draft stage refused: ${configIssues.join("; ")}`);
  }

  const cadence = cadenceSetting.value as CadenceDefault;
  const ctaVariants = ctaSetting.value as CtaVariants;
  const proofPoints = proofSetting.value as ProofPoints;
  const complianceFooter = String(footerSetting.value);
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
  const offsets = cumulativeOffsetDays(sequence);

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

      const claimContext = await loadClaimContext(deps.db, deps.getActiveSetting, lead.id);
      const writerInput = buildWriterInput(lead, sequence, proofPoint);
      const result = await writeSequenceWithGuard(
        deps,
        lead,
        systemPrompt,
        model,
        writerInput,
        proofPoint,
        complianceFooter,
        ctaText,
        claimContext,
        sequence,
        templates,
      );

      // Every writer call is spent, whatever the verdict (Session 20 finding).
      summary.tokens_used += result.tokens;
      summary.est_cost_usd += result.cost;

      if (!result.ok && result.hold) {
        // 09 §U6b/§U6c: one revision retry, then hold. No touch is written, so
        // nothing reaches approval; the refused draft is kept on the event.
        const holdReason = result.holdReason ?? "claim_guard";
        const event = holdReason === "claim_guard" ? "claim_guard_hold" : holdReason;
        const failures = result.failures ?? [];
        await deps.transition(lead.id, "drafting", "manual_hold", event, {
          rejections: result.rejections,
          // Flat, each tagged with its step (U6b readers use this list) …
          violations: failures.flatMap((f) => f.violations.map((v) => ({ ...v, step: f.step }))),
          // … and grouped per step (09 §U6c: claim_guard_hold {step, reasons}).
          steps: failures.map((f) => ({
            step: f.step,
            reasons: [...new Set(f.violations.map((v) => v.reason))],
            violations: f.violations,
          })),
          ...(result.repeats ? { repeats: result.repeats } : {}),
          draft: result.lastDraft ?? null,
          prompt_version: promptVersion,
          sequence_setting_version: sequenceSetting.version,
          evidence_policy_version: claimContext.evidencePolicyVersion,
          tokens_used: result.tokens,
          est_cost_usd: result.cost,
        });
        summary.claim_held += 1;
        const reasons =
          failures.map((f) => `step ${f.step}: ${[...new Set(f.violations.map((v) => v.reason))].join(", ")}`).join("; ") ||
          (result.repeats ? formatRepeatIssues(result.repeats).join("; ") : "") ||
          (holdReason === "claim_guard" ? "malformed writer output" : holdReason);
        try {
          await deps.telegram.sendAlert(
            `⛔ Draft hold (${event}) — lead ${lead.id} (${lead.company.name}): ${reasons}. No draft reached approval.`,
          );
        } catch (error) {
          console.warn(`[draft] hold alert failed for lead ${lead.id}:`, error);
        }
        continue;
      }

      if (!result.ok) {
        summary.generic_rejected += result.rejections.length;
        await deps.transition(lead.id, "drafting", "parked", "writer_generic_3x", {
          rejections: result.rejections,
          prompt_version: promptVersion,
          tokens_used: result.tokens,
          est_cost_usd: result.cost,
        });
        summary.parked_generic += 1;
        continue;
      }

      const { steps } = result;

      // One statement inserts every step (atomic): all N or none.
      // Follow-ups have no subject of their own (they continue step 1's
      // thread); a null subject also keeps the retired emails/reply preflight
      // check refusing them.
      const sendDb = deps.db as unknown as SupabaseClient<DatabaseWithSending>;
      const { data: touches, error: touchError } = await sendDb
        .from("touches")
        .insert(
          steps.map((step) => ({
            lead_id: lead.id,
            sequence_id: sequenceId,
            step_no: step.step_no,
            channel: "email",
            direction: "outbound",
            status: "pending_approval",
            subject: step.step_no === 1 ? step.subject : null,
            draft_body: step.body,
            body: null,
            prompt_version: promptVersion,
            claim_ledger: step.claims as unknown as Json,
          })),
        )
        .select("*");

      if (touchError || !touches || touches.length !== steps.length) {
        throw new Error(
          `Failed to insert the ${steps.length} touches for ${lead.id}: ${touchError?.message ?? `got ${touches?.length ?? 0} rows`}`,
        );
      }
      const ordered = [...touches].sort((a, b) => (a.step_no ?? 0) - (b.step_no ?? 0));
      const first = ordered[0]!;

      await deps.transition(lead.id, "drafting", "pending_approval", "drafted", {
        touch_id: first.id,
        touch_ids: ordered.map((t) => t.id),
        steps: steps.length,
        subject: first.subject,
        word_counts: steps.map((step) => wordCount(step.body)),
        claims_count: steps.reduce((n, step) => n + step.claims.length, 0),
        prompt_version: promptVersion,
        sequence_setting_version: sequenceSetting.version,
        model,
      });

      const telegramResult = await deps.telegram.sendSequenceApproval(
        {
          steps: ordered.map((touch) => {
            const spec = sequence.steps.find((s) => s.step_no === touch.step_no)!;
            const drafted = steps.find((s) => s.step_no === touch.step_no)!;
            return {
              touch_id: touch.id,
              step_no: spec.step_no,
              source: spec.source,
              delay: spec.delay,
              delay_unit: spec.delay_unit,
              offset_days: offsets.get(spec.step_no) ?? 0,
              subject: touch.subject,
              body: touch.draft_body ?? "",
              claims: drafted.claims,
            };
          }),
          sequence_setting_version: sequenceSetting.version,
        },
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
          evidence: claimContext.evidence,
          recommended_angle: lead.qualification.recommended_angle,
          evidence_fetched_at: claimContext.evidenceFetchedAt,
          evidence_policy_version: claimContext.evidencePolicyVersion,
          max_age_days: claimContext.maxAgeDays,
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
