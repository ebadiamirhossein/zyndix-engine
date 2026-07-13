import { z } from "zod";

// ---------------------------------------------------------------------------
// Apollo — fields consumed at source/enrich (doc 02 §2.1, §2.2)
// ---------------------------------------------------------------------------

export const apolloOrgSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    primary_domain: z.string().optional(),
    website_url: z.string().optional(),
    industry: z.string().optional(),
    estimated_num_employees: z.number().optional(),
    country: z.string().optional(),
    city: z.string().optional(),
    linkedin_url: z.string().optional(),
  })
  .passthrough();

export const apolloPersonSchema = z
  .object({
    id: z.string(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    title: z.string().optional(),
    email: z.string().optional(),
    linkedin_url: z.string().optional(),
    organization_id: z.string().optional(),
    organization: apolloOrgSchema.optional(),
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
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Instantly webhook envelope (doc 03 §4, build plan step 12)
// ---------------------------------------------------------------------------

export const instantlyWebhookSchema = z
  .object({
    event_type: z.string(),
    lead_email: z.string().optional(),
    email: z.string().optional(),
    campaign_id: z.string().optional(),
    email_id: z.string().optional(),
    message_id: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

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
