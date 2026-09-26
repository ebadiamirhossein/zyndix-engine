import { z } from "zod";

import { evidenceSourceTypeSchema, REPLY_CLASSIFICATIONS, replyPolicyActionSchema } from "@/types/enums";

// ---------------------------------------------------------------------------
// Qualification jsonb (doc 02 §2.3, doc 04 qualifier output)
// Field names follow doc 04: { source, observation } — not fact/source_url.
// ---------------------------------------------------------------------------

export const EVIDENCE_SOURCES = [
  "website",
  "linkedin",
  "jobs",
  "apollo",
] as const;

export const evidenceItemSchema = z
  .object({
    source: z.enum(EVIDENCE_SOURCES),
    observation: z.string().min(1),
  })
  .strict();

export const evidenceArraySchema = z.array(evidenceItemSchema).min(1);

/**
 * One item of `qualification.evidence` as STORED (09 §UR, Wave 1). The
 * qualifier's own items are `{source, observation}` (evidenceItemSchema); the
 * qualify stage appends research items deterministically, each carrying its
 * provenance so the claim guard can check freshness per item and quotes
 * against the verbatim excerpt. `observation` of a research item IS the
 * verbatim excerpt (never a paraphrase). Positional E-ids (E1…En) are assigned
 * over this stored array, so appended items keep stable ids.
 */
export const storedEvidenceItemSchema = z
  .object({
    source: z.enum([...EVIDENCE_SOURCES, "reviews", "news", "blog"] as const),
    observation: z.string().min(1),
    source_type: evidenceSourceTypeSchema.optional(),
    evidence_item_id: z.string().uuid().optional(),
    url: z.string().url().optional(),
    published_at: z.string().datetime({ offset: true }).nullable().optional(),
    fetched_at: z.string().datetime({ offset: true }).optional(),
    title: z.string().nullable().optional(),
  })
  .strict();

export type StoredEvidenceItem = z.infer<typeof storedEvidenceItemSchema>;

export const triggersSchema = z.array(z.string().min(1));

export const visibleToolsSchema = z
  .array(z.string().min(1))
  .superRefine((tools, ctx) => {
    if (tools.length > 1 && tools.includes("none_detected")) {
      ctx.addIssue({
        code: "custom",
        message: '"none_detected" must be mutually exclusive with other tools',
      });
    }
  });

// ---------------------------------------------------------------------------
// ads_attribution.utm (doc 02 §4.5)
// ---------------------------------------------------------------------------

export const utmSchema = z
  .object({
    source: z.string().optional(),
    medium: z.string().optional(),
    campaign: z.string().optional(),
    term: z.string().optional(),
    content: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// weekly_digests.stats (doc 02 §4.4)
// ---------------------------------------------------------------------------

export const digestSegmentStatsSchema = z
  .object({
    sourced: z.number().int().nonnegative().optional(),
    qualified: z.number().int().nonnegative().optional(),
    sent: z.number().int().nonnegative().optional(),
    opens: z.number().int().nonnegative().optional(),
    replies: z.number().int().nonnegative().optional(),
    meetings: z.number().int().nonnegative().optional(),
  })
  .strict();

export const digestStatsSchema = z
  .object({
    segments: z.record(z.string(), digestSegmentStatsSchema),
    angles: z
      .record(
        z.string(),
        z.object({ reply_rate: z.number().min(0).max(1) }).strict(),
      )
      .optional(),
    inbox_health: z
      .record(
        z.string(),
        z
          .object({
            health: z.string().optional(),
            bounce_rate_7d: z.number().optional(),
            paused: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    prompt_versions: z.record(z.string(), z.number().int().positive()).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// settings.value shapes (doc 02 §4.1, doc 04 §7)
// ---------------------------------------------------------------------------

export const segmentDefinitionSchema = z
  .object({
    active: z.boolean(),
    label: z.string(),
    apollo_query: z.record(z.string(), z.unknown()),
    pain_map: z.array(z.string()),
    proof_point: z.string(),
    compliance: z.string(),
    language: z.string().optional(),
  })
  .strict();

export const segmentsSettingsSchema = z.record(z.string(), segmentDefinitionSchema);

export const cadenceStepSchema = z
  .object({
    step: z.number().int().positive(),
    wait_days: z.number().int().nonnegative(),
    channel: z.string(),
    requires_approval: z.boolean(),
    hint: z.string(),
  })
  .strict();

export const cadenceDefaultSchema = z
  .object({
    steps: z.array(cadenceStepSchema).min(1),
    stop_on: z.array(z.string().min(1)),
  })
  .strict();

export const ctaVariantSchema = z
  .object({
    id: z.enum(["link", "reply"]),
    active: z.boolean(),
    text: z.string().min(1),
    /**
     * v3 (09 §U6b, Session 15): the only offer sentences an outbound draft may
     * contain, verbatim. Until the knowledge library (U13) this is the whole
     * approved offer text; the claim guard refuses any other offer.
     */
    approved_lines: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ctaVariantsSchema = z
  .object({
    variants: z.array(ctaVariantSchema).min(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    const activeCount = data.variants.filter((variant) => variant.active).length;
    if (activeCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "cta_variants must have exactly one active variant",
        path: ["variants"],
      });
    }
  });

export const proofPointsSchema = z.record(z.string(), z.string().nullable());

export const complianceFooterSchema = z.string().min(1);

export const capacityDefaultsSchema = z
  .object({
    email_inbox: z
      .object({
        start_quota: z.number().int().nonnegative(),
        max_quota: z.number().int().nonnegative(),
        ramp_step: z.number().int().nonnegative(),
        ramp_every_days: z.number().int().positive(),
      })
      .strict(),
    linkedin_account: z
      .object({
        connects_per_day: z.number().int().nonnegative(),
        messages_per_day: z.number().int().nonnegative(),
      })
      .strict(),
    auto_pause: z
      .object({
        bounce_rate_7d: z.number(),
        spam_complaints: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const sendWindowsSchema = z
  .object({
    priority_days: z.array(z.string()),
    secondary_days: z.array(z.string()),
    window_local: z.tuple([z.string(), z.string()]),
    secondary_window_local: z.tuple([z.string(), z.string()]),
    weekend: z.boolean(),
    jitter_minutes: z.number().int().nonnegative(),
    /**
     * Take the next priority window if it opens within this many hours;
     * otherwise the earliest window of either tier (09 §U3, operator decision
     * 2026-09-24). Optional so v1 still parses; the scheduler defaults it to 48.
     */
    priority_lookahead_hours: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * evidence_policy (09 §U6b): how old cited evidence may be before the claim
 * guard refuses a draft (`stale_evidence`). Versioned, never hardcoded.
 */
export const evidencePolicySchema = z
  .object({
    max_age_days: z.number().int().min(1).max(365),
  })
  .strict();

/**
 * email_sequence (09 §U6c): the steps of one outbound email sequence. Step 1
 * is enrolled by the engine; steps >= 2 are Instantly campaign steps.
 *
 * `delay` is the wait AFTER THE PREVIOUS STEP (step 1 = 0), so v1's 0/7/7
 * means days 0/7/14. Instantly's own step `delay` is the wait before the NEXT
 * email, so S20 maps engine step N's delay onto Instantly step N-1 (06 §6).
 *
 * Production rule (operator, Session 17): every delay is whole days and a
 * multiple of 7, so each follow-up lands on step 1's weekday and local time
 * on the unchanged 24/7 schedule. Drill minute-delays are never stored here.
 */
export const EMAIL_SEQUENCE_SOURCES = ["writer", "template"] as const;

export const emailSequenceStepSchema = z
  .object({
    step_no: z.number().int().positive(),
    delay: z.number().int().nonnegative(),
    delay_unit: z.enum(["minutes", "hours", "days"]),
    source: z.enum(EMAIL_SEQUENCE_SOURCES),
  })
  .strict();

export const emailSequenceSchema = z
  .object({
    steps: z.array(emailSequenceStepSchema).min(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    let templateSeen = false;
    data.steps.forEach((step, i) => {
      const path = ["steps", i];
      if (step.step_no !== i + 1) {
        ctx.addIssue({ code: "custom", message: `step_no must be contiguous from 1 (got ${step.step_no} at position ${i + 1})`, path: [...path, "step_no"] });
      }
      if (step.delay_unit !== "days") {
        ctx.addIssue({ code: "custom", message: `production delays are whole days (step ${step.step_no} uses ${step.delay_unit})`, path: [...path, "delay_unit"] });
      }
      if (step.delay % 7 !== 0) {
        ctx.addIssue({ code: "custom", message: `production delay must be a multiple of 7 days (step ${step.step_no}: ${step.delay})`, path: [...path, "delay"] });
      }
      if (i === 0 && step.delay !== 0) {
        ctx.addIssue({ code: "custom", message: "step 1 has delay 0 (it goes out when enrolled)", path: [...path, "delay"] });
      }
      if (i > 0 && step.delay === 0) {
        ctx.addIssue({ code: "custom", message: `follow-up step ${step.step_no} needs a delay > 0`, path: [...path, "delay"] });
      }
      if (i === 0 && step.source !== "writer") {
        ctx.addIssue({ code: "custom", message: "step 1 is written by the writer", path: [...path, "source"] });
      }
      if (step.source === "template") templateSeen = true;
      else if (templateSeen) {
        ctx.addIssue({ code: "custom", message: "writer steps come before template steps", path: [...path, "source"] });
      }
    });
  });

/** Placeholders a follow-up template may use; anything else is refused. */
export const FOLLOWUP_TEMPLATE_PLACEHOLDERS = ["first_name"] as const;

export const followupTemplateSchema = z
  .object({
    step_no: z.number().int().min(2),
    id: z.string().min(1),
    body: z.string().min(1),
  })
  .strict()
  .superRefine((template, ctx) => {
    for (const m of template.body.matchAll(/\{([^{}]*)\}/g)) {
      if (!(FOLLOWUP_TEMPLATE_PLACEHOLDERS as readonly string[]).includes(m[1]!)) {
        ctx.addIssue({ code: "custom", message: `unknown placeholder {${m[1]}} (allowed: {first_name})`, path: ["body"] });
      }
    }
    if (/[{}]/.test(template.body.replace(/\{first_name\}/g, ""))) {
      ctx.addIssue({ code: "custom", message: "stray brace in template body", path: ["body"] });
    }
  });

/** followup_templates (09 §U6c): fixed, operator-written step texts. */
export const followupTemplatesSchema = z
  .object({
    templates: z.array(followupTemplateSchema).min(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Set<number>();
    for (const t of data.templates) {
      if (seen.has(t.step_no)) ctx.addIssue({ code: "custom", message: `duplicate template for step ${t.step_no}`, path: ["templates"] });
      seen.add(t.step_no);
    }
  });

/**
 * send_policy (09 §U5): the thresholds preflight judges against. A versioned
 * settings record, not code, so tightening or loosening one is a new version
 * with a change note. A missing key holds every send (never defaulted).
 */
export const sendPolicySchema = z
  .object({
    /** A verification older than this is `email_unverified` (re-verify first). */
    verification_max_age_days: z.number().int().positive(),
    /** Whether MillionVerifier catch_all (which also covers "unknown") may be sent to. */
    allow_catch_all: z.boolean(),
    /** Instantly warmup health score below this is `sender_unhealthy`. */
    min_warmup_score: z.number().min(0).max(100),
    /** Another lead at the same company in active outreach within this window is `duplicate_company_active`. */
    duplicate_company_window_days: z.number().int().positive(),
    /**
     * v2 (Session 12): mailboxes approval may assign a first touch to. Absent =
     * every eligible account. Drafts are written in one person's voice, so
     * only that person's mailboxes are listed. A lead's existing binding wins.
     */
    assignable_senders: z.array(z.string().email()).min(1).optional(),
  })
  .strict();

/** Union of known settings jsonb shapes; plain text prompts are stored as strings. */
export const settingsValueSchema = z.union([
  z.string(),
  segmentsSettingsSchema,
  cadenceDefaultSchema,
  ctaVariantsSchema,
  proofPointsSchema,
  complianceFooterSchema,
  capacityDefaultsSchema,
  sendWindowsSchema,
  sendPolicySchema,
]);

// ---------------------------------------------------------------------------
// apify_actor_templates (step 6 — doc 03 §4)
// ---------------------------------------------------------------------------

export const apifyActorTemplateSchema = z
  .object({
    actor_id: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();

export const apifyActorTemplatesSchema = z
  .object({
    site: apifyActorTemplateSchema,
    tech: apifyActorTemplateSchema,
    li_posts: apifyActorTemplateSchema,
    // 09 §UR (Wave 1): research sources, optional so v1–v3 still parse.
    // Company posts reuse the li_posts actor with a company URL.
    li_company_posts: apifyActorTemplateSchema.optional(),
    li_profile: apifyActorTemplateSchema.optional(),
    jobs: apifyActorTemplateSchema.optional(),
    reviews: apifyActorTemplateSchema.optional(),
    news: apifyActorTemplateSchema.optional(),
    blog: apifyActorTemplateSchema.optional(),
  })
  .strict();

export type ApifyActorTemplates = z.infer<typeof apifyActorTemplatesSchema>;

// ---------------------------------------------------------------------------
// lead_events.detail — permissive record for audit payloads
// ---------------------------------------------------------------------------

export const leadEventDetailSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// ads_attribution.conversion_uploads — log entries (doc 02 §4.5, Phase 4)
// ---------------------------------------------------------------------------

export const conversionUploadSchema = z
  .object({
    platform: z.string(),
    uploaded_at: z.string(),
    status: z.string(),
    external_id: z.string().optional(),
  })
  .strict();

export const conversionUploadsSchema = z.array(conversionUploadSchema);

// ---------------------------------------------------------------------------
// Wave 1 settings (09 §U9, §UR, §U7). Versioned records, never hardcoded.
// ---------------------------------------------------------------------------

/**
 * operations_pause (09 §U9): the global stop plus per-campaign pauses. A
 * campaign is the sender's Instantly campaign until U14 adds engine campaigns
 * (operator, Wave 1 plan mode). Account pause stays send_accounts.health.
 * The global pause halts everything that creates or advances outreach; the
 * stop-path jobs (SAFETY_JOB_TYPES) keep running. A missing row = not paused.
 */
export const operationsPauseSchema = z
  .object({
    global: z.boolean(),
    reason: z.string().nullable(),
    paused_campaign_ids: z.array(z.string().min(1)),
  })
  .strict();

export type OperationsPause = z.infer<typeof operationsPauseSchema>;

const stageBudgetSchema = z.number().int().min(0).max(500);

/**
 * orchestrator_budgets (09 §U9): per-run limits. `limit` is the stage's batch
 * size for one orchestrate tick; 0 disables that stage. run_budget_ms bounds
 * one worker drain inside a cron invocation.
 */
export const orchestratorBudgetsSchema = z
  .object({
    run_budget_ms: z.number().int().min(5_000).max(800_000),
    stages: z
      .object({
        source: stageBudgetSchema,
        enrich: stageBudgetSchema,
        qualify: stageBudgetSchema,
        verify: stageBudgetSchema,
        draft: stageBudgetSchema,
        send_enqueue: stageBudgetSchema,
        classify: stageBudgetSchema,
      })
      .strict(),
    safety_budget_ms: z.number().int().min(5_000).max(800_000),
  })
  .strict();

export type OrchestratorBudgets = z.infer<typeof orchestratorBudgetsSchema>;

const researchSourceSchema = z
  .object({
    enabled: z.boolean(),
    /** Items requested from the actor (maxPosts / rows / maxReviews / maxArticles / pages). */
    max_items: z.number().int().min(1).max(50),
    /** Passed as Apify's maxTotalChargeUsd for the run: the provider-side hard cap. */
    max_charge_usd: z.number().min(0).max(1),
  })
  .strict();

/**
 * research_policy (09 §UR). Off by default: nothing spends Apify credits until
 * the operator turns it on. Company-level sources are reused for reuse_days;
 * items older than max_item_age_days are dropped at parse time.
 */
export const researchPolicySchema = z
  .object({
    enabled: z.boolean(),
    max_cost_usd_per_lead: z.number().min(0).max(5),
    reuse_days: z.number().int().min(1).max(365),
    max_item_age_days: z.number().int().min(1).max(3650),
    sources: z
      .object({
        li_person_post: researchSourceSchema,
        li_company_post: researchSourceSchema,
        li_profile: researchSourceSchema,
        job_post: researchSourceSchema,
        google_review: researchSourceSchema,
        news: researchSourceSchema,
        blog: researchSourceSchema,
      })
      .strict(),
  })
  .strict();

export type ResearchPolicy = z.infer<typeof researchPolicySchema>;

/**
 * reply_policy (09 §U7). The deterministic table that decides what happens
 * after the model classifies a reply. The action enum has no send action, so
 * an automatic reply cannot be configured (brief §11).
 */
export const replyPolicySchema = z
  .object({
    table: z
      .object(
        Object.fromEntries(REPLY_CLASSIFICATIONS.map((c) => [c, replyPolicyActionSchema])) as Record<
          (typeof REPLY_CLASSIFICATIONS)[number],
          typeof replyPolicyActionSchema
        >,
      )
      .strict(),
    /** Below this confidence the policy routes to human_review whatever the class. */
    confidence_floor: z.number().min(0).max(1),
    /** OOO with no stated return date snoozes this many days. */
    ooo_default_days: z.number().int().min(1).max(90),
    /** wrong_person with a named referral → this action; without one → table.wrong_person. */
    wrong_person_with_referral: replyPolicyActionSchema,
    /** A reply that negotiates price or commits to delivery → this action. */
    negotiation: replyPolicyActionSchema,
  })
  .strict();

export type ReplyPolicy = z.infer<typeof replyPolicySchema>;
