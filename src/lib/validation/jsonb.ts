import { z } from "zod";

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
