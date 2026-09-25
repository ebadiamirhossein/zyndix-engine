import { z } from "zod";

// ---------------------------------------------------------------------------
// Apollo — fields consumed at source/enrich (doc 02 §2.1, §2.2)
// ---------------------------------------------------------------------------

export const apolloOrgSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    primary_domain: z.string().optional().nullable(),
    website_url: z.string().optional().nullable(),
    industry: z.string().optional().nullable(),
    estimated_num_employees: z.number().optional().nullable(),
    country: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    linkedin_url: z.string().optional().nullable(),
  })
  .passthrough();

export const apolloPersonSchema = z
  .object({
    id: z.string(),
    first_name: z.string().optional().nullable(),
    last_name: z.string().optional().nullable(),
    last_name_obfuscated: z.string().optional().nullable(),
    title: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    linkedin_url: z.string().optional().nullable(),
    organization_id: z.string().optional().nullable(),
    organization: apolloOrgSchema.optional().nullable(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Apify — run status we poll (doc 03 §4)
// ---------------------------------------------------------------------------

export const apifyRunResultSchema = z
  .object({
    id: z.string(),
    status: z.enum([
      "READY",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "TIMING-OUT",
      "TIMED-OUT",
      "ABORTING",
      "ABORTED",
    ]),
    defaultDatasetId: z.string().optional(),
    startedAt: z.string().optional().nullable(),
    finishedAt: z.string().optional().nullable(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Instantly webhook envelope (09 §U6). Fields per the official webhook guide
// (developer.instantly.ai, read 2026-09-25); the OpenAPI spec has no payload
// schema. Only event_type is required: every other field is optional and may
// be null. Unknown fields (lead custom variables) pass through untouched.
// ---------------------------------------------------------------------------

const optionalText = z.string().nullable().optional();

export const instantlyWebhookSchema = z
  .object({
    event_type: z.string().min(1),
    timestamp: z.union([z.string(), z.number()]).nullable().optional(),
    workspace: optionalText,
    campaign_id: optionalText,
    campaign_name: optionalText,
    lead_email: optionalText,
    email: optionalText,
    email_account: optionalText,
    email_id: optionalText,
    message_id: optionalText,
    step: z.union([z.number(), z.string()]).nullable().optional(),
    variant: z.union([z.number(), z.string()]).nullable().optional(),
    is_first: z.boolean().nullable().optional(),
    is_auto_reply: z.union([z.boolean(), z.number(), z.string()]).nullable().optional(),
    email_subject: optionalText,
    reply_subject: optionalText,
    reply_text: optionalText,
    reply_text_snippet: optionalText,
    unibox_url: optionalText,
  })
  .passthrough();

export type InstantlyWebhookPayload = z.infer<typeof instantlyWebhookSchema>;

// ---------------------------------------------------------------------------
// Calendly webhook envelope (doc 03 §4: invitee.created)
// ---------------------------------------------------------------------------

export const calendlyInviteeSchema = z
  .object({
    email: z.string().email(),
    name: z.string().optional(),
    uri: z.string().optional(),
  })
  .passthrough();

export const calendlyWebhookSchema = z
  .object({
    event: z.string(),
    created_at: z.string().optional(),
    payload: z
      .object({
        email: z.string().email().optional(),
        invitee: calendlyInviteeSchema.optional(),
        scheduled_event: z
          .object({
            uri: z.string().optional(),
            start_time: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Telegram Bot API update (doc 03 §5)
// ---------------------------------------------------------------------------

export const telegramUserSchema = z
  .object({
    id: z.number(),
    is_bot: z.boolean().optional(),
    first_name: z.string().optional(),
    username: z.string().optional(),
  })
  .passthrough();

export const telegramMessageSchema = z
  .object({
    message_id: z.number(),
    from: telegramUserSchema.optional(),
    chat: z.object({ id: z.number() }).passthrough(),
    text: z.string().optional(),
    date: z.number().optional(),
  })
  .passthrough();

export const telegramCallbackQuerySchema = z
  .object({
    id: z.string(),
    from: telegramUserSchema,
    message: telegramMessageSchema.optional(),
    data: z.string().optional(),
  })
  .passthrough();

export const telegramUpdateSchema = z
  .object({
    update_id: z.number(),
    message: telegramMessageSchema.optional(),
    callback_query: telegramCallbackQuerySchema.optional(),
  })
  .passthrough();
