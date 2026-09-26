import { z } from "zod";

// Instantly API v2 response shapes. Source: the official OpenAPI spec at
// https://api.instantly.ai/openapi/api_v2.json and developer.instantly.ai,
// read 2026-09-25. Only fields the engine consumes are typed; everything else
// passes through untouched. A consumed field of the wrong type fails the parse
// (no coercion) — that is the contract the tests lock.

// ---------------------------------------------------------------------------
// Enums (spec descriptions). Unknown codes stay numbers and map to "unknown".
// ---------------------------------------------------------------------------

export const ACCOUNT_STATUS_LABELS: Record<number, string> = {
  1: "active",
  2: "paused",
  3: "maintenance_paused",
  [-1]: "connection_error",
  [-2]: "soft_bounce_error",
  [-3]: "sending_error",
};

export const ACCOUNT_WARMUP_STATUS_LABELS: Record<number, string> = {
  1: "active",
  0: "paused",
  [-1]: "banned",
  [-2]: "spam_folder_unknown",
  [-3]: "permanent_suspension",
};

export const ACCOUNT_PROVIDER_LABELS: Record<number, string> = {
  1: "custom_imap_smtp",
  2: "google",
  3: "microsoft",
  4: "aws",
  8: "airmail",
  11: "airmail_instant",
};

export const CAMPAIGN_STATUS_LABELS: Record<number, string> = {
  0: "draft",
  1: "active",
  2: "paused",
  3: "completed",
  4: "running_subsequences",
  [-99]: "account_suspended",
  [-1]: "accounts_unhealthy",
  [-2]: "bounce_protect",
};

export const LEAD_STATUS_LABELS: Record<number, string> = {
  1: "active",
  2: "paused",
  3: "completed",
  [-1]: "bounced",
  [-2]: "unsubscribed",
  [-3]: "skipped",
};

export function label(map: Record<number, string>, code: number | null | undefined): string {
  if (code === null || code === undefined) return "unknown";
  return map[code] ?? `unknown(${code})`;
}

// ---------------------------------------------------------------------------
// Error body: { statusCode, error, message } (a few endpoints send { error })
// ---------------------------------------------------------------------------

export const instantlyErrorBodySchema = z
  .object({
    statusCode: z.number().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Workspace — GET /api/v2/workspaces/current
// ---------------------------------------------------------------------------

export const instantlyWorkspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    plan_id: z.string().nullable().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Accounts — GET /api/v2/accounts, GET /api/v2/accounts/{email}
// ---------------------------------------------------------------------------

export const instantlyAccountSchema = z
  .object({
    email: z.string().min(1),
    status: z.number().int(),
    warmup_status: z.number().int(),
    provider_code: z.number().int(),
    setup_pending: z.boolean(),
    daily_limit: z.number().nullable().optional(),
    stat_warmup_score: z.number().nullable().optional(),
    timestamp_created: z.string(),
    timestamp_warmup_start: z.string().nullable().optional(),
  })
  .passthrough();

function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      items: z.array(item),
      next_starting_after: z.string().nullable().optional(),
    })
    .passthrough();
}

export const instantlyAccountPageSchema = pageSchema(instantlyAccountSchema);

// ---------------------------------------------------------------------------
// Warmup analytics — POST /api/v2/accounts/warmup-analytics
// ---------------------------------------------------------------------------

export const instantlyWarmupAggregateSchema = z
  .object({
    sent: z.number().nullable().optional(),
    received: z.number().nullable().optional(),
    landed_inbox: z.number().nullable().optional(),
    landed_spam: z.number().nullable().optional(),
    health_score: z.number().nullable().optional(),
    health_score_label: z.string().nullable().optional(),
  })
  .passthrough();

export const instantlyWarmupAnalyticsSchema = z
  .object({
    email_date_data: z.record(z.string(), z.unknown()).optional(),
    aggregate_data: z.record(z.string(), instantlyWarmupAggregateSchema),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Campaigns — GET /api/v2/campaigns, GET /api/v2/campaigns/{id},
// POST /api/v2/campaigns/{id}/pause|activate
// ---------------------------------------------------------------------------

export const instantlyCampaignSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    status: z.number().int(),
    timestamp_created: z.string(),
  })
  .passthrough();

export const instantlyCampaignPageSchema = pageSchema(instantlyCampaignSchema);

/**
 * The configuration fields the sender-pinning check reads back (U5). Every one
 * is optional so a campaign listing still parses; when present it must have
 * the spec's type. Returned by GET /api/v2/campaigns/{id} and POST /api/v2/campaigns.
 */
export const instantlyCampaignDetailSchema = instantlyCampaignSchema
  .extend({
    email_list: z.array(z.string()).optional(),
    daily_limit: z.number().nullable().optional(),
    open_tracking: z.boolean().nullable().optional(),
    link_tracking: z.boolean().nullable().optional(),
    text_only: z.boolean().nullable().optional(),
    first_email_text_only: z.boolean().nullable().optional(),
    stop_on_reply: z.boolean().nullable().optional(),
    stop_for_company: z.boolean().nullable().optional(),
    insert_unsubscribe_header: z.boolean().nullable().optional(),
    sequences: z
      .array(
        z
          .object({
            steps: z.array(
              z
                .object({
                  type: z.string(),
                  delay: z.number(),
                  /** Spec default "days" when absent (09 §U6c S20 drift diff). */
                  delay_unit: z.enum(["minutes", "hours", "days"]).nullable().optional(),
                  variants: z.array(
                    z.object({ subject: z.string(), body: z.string(), v_disabled: z.boolean().nullable().optional() }).passthrough(),
                  ),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Emails — GET /api/v2/emails, POST /api/v2/emails/reply (U5 threaded
// follow-ups). A reply shares the original's thread_id.
// ---------------------------------------------------------------------------

export const EMAIL_UE_TYPE_LABELS: Record<number, string> = {
  1: "sent_from_campaign",
  2: "received",
  3: "sent",
  4: "scheduled",
};

export const instantlyEmailSchema = z
  .object({
    id: z.string().min(1),
    timestamp_created: z.string(),
    message_id: z.string(),
    subject: z.string(),
    eaccount: z.string(),
    to_address_email_list: z.string(),
    // GET /api/v2/emails/{id} (09 §U6c): the post-send recipient check reads these.
    cc_address_email_list: z.string().nullable().optional(),
    bcc_address_email_list: z.string().nullable().optional(),
    thread_id: z.string().nullable().optional(),
    lead: z.string().nullable().optional(),
    campaign_id: z.string().nullable().optional(),
    ue_type: z.number().nullable().optional(),
    step: z.string().nullable().optional(),
    // Documented Email fields the reply poll (U6 reconcile) reads.
    timestamp_email: z.string().nullable().optional(),
    from_address_email: z.string().nullable().optional(),
    lead_id: z.string().nullable().optional(),
    body: z.object({ text: z.string().nullable().optional(), html: z.string().nullable().optional() }).passthrough().nullable().optional(),
    content_preview: z.string().nullable().optional(),
    /** 0 = false, 1 = true (OpenAPI Email.is_auto_reply). */
    is_auto_reply: z.number().nullable().optional(),
    i_status: z.number().nullable().optional(),
  })
  .passthrough();

export const instantlyEmailPageSchema = pageSchema(instantlyEmailSchema);

// ---------------------------------------------------------------------------
// Daily account analytics — GET /api/v2/accounts/analytics/daily (09 §U6c S20:
// provider_daily_limit). `sent` = "the total number of campaign emails sent on
// this date by this account, including emails for subsequences" (spec). The
// spec does not say which timezone `date` is in.
// ---------------------------------------------------------------------------

export const instantlyAccountDailyAnalyticsSchema = z.array(
  z
    .object({
      date: z.string().min(1),
      email_account: z.string().min(1),
      sent: z.number().int().nonnegative(),
    })
    .passthrough(),
);

// ---------------------------------------------------------------------------
// Leads — POST /api/v2/leads/list, DELETE /api/v2/leads/{id}
// ---------------------------------------------------------------------------

export const instantlyLeadSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().nullable().optional(),
    campaign: z.string().nullable().optional(),
    status: z.number().int(),
    timestamp_created: z.string(),
  })
  .passthrough();

export const instantlyLeadPageSchema = pageSchema(instantlyLeadSchema);

// ---------------------------------------------------------------------------
// Bulk add — POST /api/v2/leads/add. Used for single-lead enrollment because
// it is the only create endpoint that reports skips explicitly.
// ---------------------------------------------------------------------------

export const instantlyLeadsAddResponseSchema = z
  .object({
    status: z.string(),
    total_sent: z.number().int(),
    leads_uploaded: z.number().int(),
    in_blocklist: z.number().int(),
    duplicated_leads: z.number().int(),
    skipped_count: z.number().int(),
    invalid_email_count: z.number().int(),
    incomplete_count: z.number().int(),
    duplicate_email_count: z.number().int(),
    remaining_in_plan: z.number().nullable().optional(),
    created_leads: z.array(
      z
        .object({
          index: z.number().int(),
          id: z.string().min(1),
          email: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Block list — POST /api/v2/block-lists-entries
// ---------------------------------------------------------------------------

export const instantlyBlockListEntrySchema = z
  .object({
    id: z.string().min(1),
    bl_value: z.string(),
    is_domain: z.boolean(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Webhook event types — GET /api/v2/webhooks/event-types (plan-tier probe)
// ---------------------------------------------------------------------------

export const instantlyWebhookEventTypesSchema = z
  .object({
    event_types: z.array(z.object({}).passthrough()),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Webhooks — /api/v2/webhooks (09 §U6). No HMAC signing exists; deliveries are
// authenticated by a static header we set in `headers`. That header value is a
// secret, so it is dropped at parse time and never returned to callers.
// ---------------------------------------------------------------------------

export const instantlyWebhookConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable().optional(),
    target_hook_url: z.string(),
    event_type: z.string().nullable().optional(),
    campaign: z.string().nullable().optional(),
    status: z.number().nullable().optional(),
    timestamp_created: z.string().nullable().optional(),
    timestamp_error: z.string().nullable().optional(),
    headers: z.record(z.string(), z.string()).nullable().optional(),
  })
  .passthrough()
  .transform(({ headers, ...rest }) => ({ ...rest, header_names: headers ? Object.keys(headers) : [] }));

export const instantlyWebhookPageSchema = pageSchema(instantlyWebhookConfigSchema);

export const instantlyWebhookTestResultSchema = z
  .object({
    success: z.boolean(),
    status_code: z.number().nullable().optional(),
    response_time_ms: z.number().nullable().optional(),
    message: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();

export type InstantlyWebhook = z.infer<typeof instantlyWebhookConfigSchema>;
export type InstantlyWebhookTestResult = z.infer<typeof instantlyWebhookTestResultSchema>;

export type InstantlyWorkspace = z.infer<typeof instantlyWorkspaceSchema>;
export type InstantlyAccount = z.infer<typeof instantlyAccountSchema>;
export type InstantlyWarmupAggregate = z.infer<typeof instantlyWarmupAggregateSchema>;
export type InstantlyWarmupAnalytics = z.infer<typeof instantlyWarmupAnalyticsSchema>;
export type InstantlyCampaign = z.infer<typeof instantlyCampaignSchema>;
export type InstantlyCampaignDetail = z.infer<typeof instantlyCampaignDetailSchema>;
export type InstantlyAccountDailyAnalytics = z.infer<typeof instantlyAccountDailyAnalyticsSchema>;
export type InstantlyEmail = z.infer<typeof instantlyEmailSchema>;
export type InstantlyLead = z.infer<typeof instantlyLeadSchema>;
export type InstantlyLeadsAddResponse = z.infer<typeof instantlyLeadsAddResponseSchema>;
export type InstantlyBlockListEntry = z.infer<typeof instantlyBlockListEntrySchema>;
