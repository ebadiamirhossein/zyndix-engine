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

export const visibleToolsSchema = z.array(z.string().min(1));

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
  })
  .strict();

/** Union of known settings jsonb shapes; plain text prompts are stored as strings. */
export const settingsValueSchema = z.union([
  z.string(),
  segmentsSettingsSchema,
  cadenceDefaultSchema,
  capacityDefaultsSchema,
  sendWindowsSchema,
]);

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
