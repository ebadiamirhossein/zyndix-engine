import type { z } from "zod";

import {
  instantlyAccountDailyAnalyticsSchema,
  instantlyAccountPageSchema,
  instantlyAccountSchema,
  instantlyBlockListEntrySchema,
  instantlyCampaignDetailSchema,
  instantlyCampaignPageSchema,
  instantlyCampaignSchema,
  instantlyEmailPageSchema,
  instantlyEmailSchema,
  instantlyErrorBodySchema,
  instantlyLeadPageSchema,
  instantlyLeadSchema,
  instantlyLeadsAddResponseSchema,
  instantlyWarmupAnalyticsSchema,
  instantlyWebhookEventTypesSchema,
  instantlyWebhookPageSchema,
  instantlyWebhookConfigSchema,
  instantlyWebhookTestResultSchema,
  instantlyWorkspaceSchema,
  type InstantlyAccount,
  type InstantlyAccountDailyAnalytics,
  type InstantlyBlockListEntry,
  type InstantlyCampaign,
  type InstantlyCampaignDetail,
  type InstantlyEmail,
  type InstantlyLead,
  type InstantlyLeadsAddResponse,
  type InstantlyWarmupAggregate,
  type InstantlyWarmupAnalytics,
  type InstantlyWebhook,
  type InstantlyWebhookTestResult,
  type InstantlyWorkspace,
} from "@/lib/integrations/instantly-types";
import { instantlyEmailsLimiter, type RateLimiter } from "@/lib/integrations/rate-limit";

// Instantly API v2 adapter (09 §U4). Endpoints are taken from the official
// OpenAPI spec (https://api.instantly.ai/openapi/api_v2.json), read 2026-09-25.
// No DB access here; the send stage (U5) owns persistence.
//
// Error taxonomy — the part U5's no-resend rule rests on:
//   InstantlyRetryableError        nothing was processed; safe to try again
//                                  (429 anywhere; 5xx / network on reads;
//                                  connect-phase failures anywhere)
//   InstantlyPermanentError        will not succeed as sent (4xx, bad config);
//     InstantlyContractError       a 2xx read whose body failed Zod
//   InstantlyUncertainOutcomeError a mutation that was dispatched and may have
//                                  been applied (timeout/reset after dispatch,
//                                  any 5xx, an unreadable 2xx). Never resend —
//                                  reconcile with findLeadInCampaign().
//
// Mutations are never retried inside the adapter. Reads retry once.
// Instantly has no idempotency-key header; enrollment dedupes with the
// skip_if_in_workspace / skip_if_in_campaign flags instead.

export const INSTANTLY_BASE_URL = "https://api.instantly.ai";

const DEFAULT_TIMEOUT_MS = 15_000;
const READ_RETRY_DEFAULT_WAIT_MS = 1_000;
const READ_RETRY_MAX_WAIT_MS = 10_000;
const BODY_EXCERPT_CHARS = 500;
const DEFAULT_MAX_PAGES = 10;
const PAGE_LIMIT = 100;

/** Failures raised before any byte reached Instantly. */
const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

type ErrorContext = {
  op: string;
  method: HttpMethod;
  path: string;
  status: number | null;
};

export class InstantlyError extends Error {
  readonly op: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly status: number | null;

  constructor(message: string, ctx: ErrorContext) {
    super(message);
    this.name = "InstantlyError";
    this.op = ctx.op;
    this.method = ctx.method;
    this.path = ctx.path;
    this.status = ctx.status;
  }
}

export class InstantlyRetryableError extends InstantlyError {
  /** Parsed from Retry-After when present; null means the caller's backoff decides. */
  readonly retryAfterMs: number | null;

  constructor(message: string, ctx: ErrorContext, retryAfterMs: number | null) {
    super(message, ctx);
    this.name = "InstantlyRetryableError";
    this.retryAfterMs = retryAfterMs;
  }
}

export type InstantlyPermanentKind =
  | "validation"
  | "auth"
  | "plan"
  | "scope"
  | "contract"
  | "config"
  | "unexpected";

export class InstantlyPermanentError extends InstantlyError {
  readonly kind: InstantlyPermanentKind;

  constructor(message: string, ctx: ErrorContext, kind: InstantlyPermanentKind) {
    super(message, ctx);
    this.name = "InstantlyPermanentError";
    this.kind = kind;
  }
}

export class InstantlyContractError extends InstantlyPermanentError {
  constructor(message: string, ctx: ErrorContext) {
    super(message, ctx, "contract");
    this.name = "InstantlyContractError";
  }
}

export type InstantlyUncertainReason =
  | "timeout_after_dispatch"
  | "network_after_dispatch"
  | "server_error"
  | "unreadable_response";

export class InstantlyUncertainOutcomeError extends InstantlyError {
  readonly reason: InstantlyUncertainReason;
  /** What was being changed — enough for a reconcile job to look it up. */
  readonly fingerprint: Record<string, string>;

  constructor(
    message: string,
    ctx: ErrorContext,
    reason: InstantlyUncertainReason,
    fingerprint: Record<string, string>,
  ) {
    super(message, ctx);
    this.name = "InstantlyUncertainOutcomeError";
    this.reason = reason;
    this.fingerprint = fingerprint;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Retry-After as seconds or an HTTP-date. Null when absent or unparseable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(Number(trimmed) * 1000);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

function redact(text: string, secret: string | null): string {
  let out = text;
  if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

function excerpt(text: string, secret: string | null): string {
  const body = text.length > BODY_EXCERPT_CHARS ? `${text.slice(0, BODY_EXCERPT_CHARS)}…` : text;
  return redact(body, secret);
}

function describeErrorBody(text: string, secret: string | null): string {
  if (!text) return "(empty body)";
  try {
    const parsed = instantlyErrorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success && (parsed.data.message || parsed.data.error)) {
      return excerpt([parsed.data.error, parsed.data.message].filter(Boolean).join(": "), secret);
    }
  } catch {
    // not JSON — fall through to the raw excerpt
  }
  return excerpt(text, secret);
}

function networkCode(error: unknown): string | null {
  const read = (value: unknown): string | null =>
    typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
      ? value.code
      : null;
  if (typeof error !== "object" || error === null) return null;
  return read(error) ?? ("cause" in error ? read(error.cause) : null);
}

function errorName(error: unknown): string {
  return error instanceof Error || (typeof error === "object" && error !== null && "name" in error)
    ? String((error as { name: unknown }).name)
    : "unknown";
}

function isTimeoutOrAbort(error: unknown): boolean {
  const name = errorName(error);
  return name === "TimeoutError" || name === "AbortError";
}

function zodSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type InstantlyClientOptions = {
  /** Defaults to process.env.INSTANTLY_API_KEY, read at call time. */
  apiKey?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Spacing for GET /api/v2/emails (20 req/min). Defaults to the process-wide limiter. */
  emailsLimiter?: RateLimiter;
};

type RequestSpec = {
  op: string;
  method: HttpMethod;
  path: string;
  /** An array value is sent as a repeated parameter (?emails=a&emails=b). */
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
  mutating: boolean;
  fingerprint?: Record<string, string>;
};

export type EnrollLeadInput = {
  campaignId: string;
  lead: {
    email: string;
    first_name?: string;
    last_name?: string;
    company_name?: string;
    website?: string;
    personalization?: string;
    custom_variables?: Record<string, string | number | boolean | null>;
  };
  /**
   * workspace (default): skip if the email exists anywhere in the workspace.
   * campaign: skip only if already in this campaign.
   */
  dedupe?: "workspace" | "campaign";
};

export type EnrollSkipReason = "already_enrolled" | "blocklisted" | "invalid_email" | "incomplete";

export type EnrollLeadResult =
  | { outcome: "created"; leadId: string; raw: InstantlyLeadsAddResponse }
  | { outcome: "skipped"; reason: EnrollSkipReason; raw: InstantlyLeadsAddResponse };

export type PagedResult<T> = { items: T[]; truncated: boolean };

/**
 * POST /api/v2/campaigns body (spec). Only the fields U5's sender-pinned
 * campaigns set are typed; the script builds the full payload.
 */
export type CreateCampaignInput = {
  name: string;
  campaign_schedule: {
    schedules: Array<{
      name: string;
      timing: { from: string; to: string };
      days: Partial<Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", boolean>>;
      timezone: string;
    }>;
    start_date?: string | null;
    end_date?: string | null;
  };
  sequences: Array<{
    steps: Array<{
      type: "email";
      delay: number;
      /** Spec default "days". */
      delay_unit?: "minutes" | "hours" | "days";
      variants: Array<{ subject: string; body: string }>;
    }>;
  }>;
  email_list: string[];
  daily_limit?: number | null;
  daily_max_leads?: number | null;
  email_gap?: number | null;
  random_wait_max?: number | null;
  open_tracking: boolean;
  link_tracking?: boolean | null;
  text_only?: boolean | null;
  first_email_text_only?: boolean | null;
  stop_on_reply?: boolean | null;
  stop_on_auto_reply?: boolean | null;
  stop_for_company?: boolean | null;
  insert_unsubscribe_header?: boolean | null;
};

/** POST /api/v2/emails/reply — a follow-up sent into the original's thread. */
export type ReplyToEmailInput = {
  /** The connected sending account; U5 passes the lead's bound send_account. */
  eaccount: string;
  /** Instantly id of the email being replied to (step 1's sent email). */
  replyToUuid: string;
  subject: string;
  body: { text?: string; html?: string };
  /**
   * Extra recipients (`additional_recipients`). The endpoint's DEFAULT
   * recipient is "the sender of the email being replied to" (OpenAPI spec) —
   * for a follow-up to our own step 1 that is our own mailbox, so the send
   * stage passes the lead here (U6 drill, Session 14). There is no `to` field.
   */
  additionalRecipients?: string[];
};

export type ListEmailsParams = {
  limit?: number;
  startingAfter?: string;
  /** A lead email address, or "thread:<thread_id>". */
  search?: string;
  lead?: string;
  campaignId?: string;
  eaccount?: string;
  emailType?: "received" | "sent" | "manual";
  minTimestampCreated?: string;
  sortOrder?: "asc" | "desc";
};

export type AccountHealthVerdict = "healthy" | "degraded" | "unhealthy" | "unknown";

export type AccountHealth = {
  email: string;
  verdict: AccountHealthVerdict;
  reasons: string[];
  warmupScore: number | null;
};

export function createInstantlyClient(options: InstantlyClientOptions = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? INSTANTLY_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const emailsLimiter = options.emailsLimiter ?? instantlyEmailsLimiter;

  function apiKey(ctx: ErrorContext): string {
    const key = options.apiKey ?? process.env.INSTANTLY_API_KEY;
    if (!key) {
      throw new InstantlyPermanentError("INSTANTLY_API_KEY is not configured", ctx, "config");
    }
    return key;
  }

  async function request<T>(spec: RequestSpec, schema: z.ZodType<T>): Promise<T> {
    const ctx = (status: number | null): ErrorContext => ({
      op: spec.op,
      method: spec.method,
      path: spec.path,
      status,
    });
    const key = apiKey(ctx(null));
    const where = `Instantly ${spec.op} (${spec.method} ${spec.path})`;
    const fingerprint = spec.fingerprint ?? {};

    const url = new URL(spec.path, baseUrl);
    for (const [name, value] of Object.entries(spec.query ?? {})) {
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, item);
      else if (value !== undefined) url.searchParams.set(name, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      accept: "application/json",
    };
    if (spec.body !== undefined) headers["content-type"] = "application/json";

    const attempts = spec.mutating ? 1 : 2;

    for (let attempt = 0; ; attempt++) {
      try {
        return await once();
      } catch (error) {
        const canRetry =
          error instanceof InstantlyRetryableError &&
          !spec.mutating &&
          attempt < attempts - 1 &&
          (error.retryAfterMs ?? 0) <= READ_RETRY_MAX_WAIT_MS;
        if (!canRetry) throw error;
        await sleep(error.retryAfterMs ?? READ_RETRY_DEFAULT_WAIT_MS);
      }
    }

    async function once(): Promise<T> {
      let response: Response;
      try {
        response = await fetchImpl(url.toString(), {
          method: spec.method,
          headers,
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const code = networkCode(error);
        if (code !== null && CONNECT_PHASE_CODES.has(code)) {
          throw new InstantlyRetryableError(`${where}: connection failed (${code})`, ctx(null), null);
        }
        const what = isTimeoutOrAbort(error)
          ? `timed out or aborted after dispatch (${errorName(error)})`
          : `network error after dispatch (${code ?? errorName(error)})`;
        if (spec.mutating) {
          throw new InstantlyUncertainOutcomeError(
            `${where}: ${what} — outcome unknown, do not resend`,
            ctx(null),
            isTimeoutOrAbort(error) ? "timeout_after_dispatch" : "network_after_dispatch",
            fingerprint,
          );
        }
        throw new InstantlyRetryableError(`${where}: ${what}`, ctx(null), null);
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (spec.mutating && response.ok) {
          throw new InstantlyUncertainOutcomeError(
            `${where}: ${response.status} accepted but body unreadable (${errorName(error)}) — do not resend`,
            ctx(response.status),
            "unreadable_response",
            fingerprint,
          );
        }
        if (!response.ok) {
          text = "";
        } else {
          throw new InstantlyRetryableError(
            `${where}: body unreadable (${errorName(error)})`,
            ctx(response.status),
            null,
          );
        }
      }

      const status = response.status;
      if (!response.ok) {
        const detail = describeErrorBody(text, key);
        const message = `${where}: ${status} ${detail}`;
        if (status === 429) {
          throw new InstantlyRetryableError(
            message,
            ctx(status),
            parseRetryAfter(response.headers.get("retry-after")),
          );
        }
        if (status >= 500) {
          if (spec.mutating) {
            throw new InstantlyUncertainOutcomeError(
              `${message} — may have been applied, do not resend`,
              ctx(status),
              "server_error",
              fingerprint,
            );
          }
          throw new InstantlyRetryableError(message, ctx(status), parseRetryAfter(response.headers.get("retry-after")));
        }
        if (status === 401) throw new InstantlyPermanentError(message, ctx(status), "auth");
        if (status === 402) throw new InstantlyPermanentError(message, ctx(status), "plan");
        if (status === 403) throw new InstantlyPermanentError(message, ctx(status), "scope");
        if (status >= 400) throw new InstantlyPermanentError(message, ctx(status), "validation");
        if (spec.mutating) {
          throw new InstantlyUncertainOutcomeError(message, ctx(status), "unreadable_response", fingerprint);
        }
        throw new InstantlyPermanentError(message, ctx(status), "unexpected");
      }

      let json: unknown;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        return shapeFailure(status, `body is not JSON: ${excerpt(text, key)}`);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        return shapeFailure(status, `response failed validation: ${zodSummary(parsed.error)}`);
      }
      return parsed.data;
    }

    function shapeFailure(status: number, detail: string): never {
      if (spec.mutating) {
        throw new InstantlyUncertainOutcomeError(
          `${where}: ${status} accepted but ${detail} — do not resend`,
          ctx(status),
          "unreadable_response",
          fingerprint,
        );
      }
      throw new InstantlyContractError(`${where}: ${detail}`, ctx(status));
    }
  }

  async function collectPages<T>(
    fetchPage: (startingAfter: string | undefined) => Promise<{ items: T[]; next_starting_after?: string | null }>,
    maxPages: number,
  ): Promise<PagedResult<T>> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await fetchPage(cursor);
      items.push(...result.items);
      const next = result.next_starting_after ?? undefined;
      if (!next || result.items.length === 0) return { items, truncated: false };
      cursor = next;
    }
    return { items, truncated: true };
  }

  // ---- reads ---------------------------------------------------------------

  function getCurrentWorkspace(): Promise<InstantlyWorkspace> {
    return request(
      { op: "getCurrentWorkspace", method: "GET", path: "/api/v2/workspaces/current", mutating: false },
      instantlyWorkspaceSchema,
    );
  }

  function listAccounts(params: { limit?: number; startingAfter?: string } = {}) {
    return request(
      {
        op: "listAccounts",
        method: "GET",
        path: "/api/v2/accounts",
        query: { limit: params.limit ?? PAGE_LIMIT, starting_after: params.startingAfter },
        mutating: false,
      },
      instantlyAccountPageSchema,
    );
  }

  function listAllAccounts(params: { maxPages?: number } = {}): Promise<PagedResult<InstantlyAccount>> {
    return collectPages((startingAfter) => listAccounts({ startingAfter }), params.maxPages ?? DEFAULT_MAX_PAGES);
  }

  function getAccount(email: string): Promise<InstantlyAccount> {
    return request(
      {
        op: "getAccount",
        method: "GET",
        path: `/api/v2/accounts/${encodeURIComponent(email)}`,
        mutating: false,
      },
      instantlyAccountSchema,
    );
  }

  async function getWarmupAnalytics(emails: string[]): Promise<InstantlyWarmupAnalytics> {
    const path = "/api/v2/accounts/warmup-analytics";
    if (emails.length < 1 || emails.length > 100) {
      throw new InstantlyPermanentError(
        `Instantly getWarmupAnalytics: emails must be 1..100, got ${emails.length}`,
        { op: "getWarmupAnalytics", method: "POST", path, status: null },
        "validation",
      );
    }
    return request(
      { op: "getWarmupAnalytics", method: "POST", path, body: { emails }, mutating: false },
      instantlyWarmupAnalyticsSchema,
    );
  }

  function listCampaigns(params: { limit?: number; startingAfter?: string } = {}) {
    return request(
      {
        op: "listCampaigns",
        method: "GET",
        path: "/api/v2/campaigns",
        query: { limit: params.limit ?? PAGE_LIMIT, starting_after: params.startingAfter },
        mutating: false,
      },
      instantlyCampaignPageSchema,
    );
  }

  function listAllCampaigns(params: { maxPages?: number } = {}): Promise<PagedResult<InstantlyCampaign>> {
    return collectPages((startingAfter) => listCampaigns({ startingAfter }), params.maxPages ?? DEFAULT_MAX_PAGES);
  }

  function getCampaign(id: string): Promise<InstantlyCampaignDetail> {
    return request(
      { op: "getCampaign", method: "GET", path: `/api/v2/campaigns/${encodeURIComponent(id)}`, mutating: false },
      instantlyCampaignDetailSchema,
    );
  }

  /** Reconcile primitive: is this email enrolled in this campaign? Null when absent. */
  async function findLeadInCampaign(campaignId: string, email: string): Promise<InstantlyLead | null> {
    const page = await request(
      {
        op: "findLeadInCampaign",
        method: "POST",
        path: "/api/v2/leads/list",
        body: { campaign: campaignId, contacts: [email], limit: 10 },
        mutating: false,
      },
      instantlyLeadPageSchema,
    );
    const wanted = email.trim().toLowerCase();
    return (
      page.items.find(
        (lead) =>
          (lead.email ?? "").trim().toLowerCase() === wanted &&
          (lead.campaign === undefined || lead.campaign === null || lead.campaign === campaignId),
      ) ?? null
    );
  }

  /**
   * One page of a campaign's leads (POST /api/v2/leads/list, a read). The
   * campaign --update guard (09 §U6c) only needs to know whether any exist;
   * the reconcile lead sweep (S21) pages through them.
   */
  function listCampaignLeads(campaignId: string, params: { limit?: number; startingAfter?: string } = {}) {
    return request(
      {
        op: "listCampaignLeads",
        method: "POST",
        path: "/api/v2/leads/list",
        body: {
          campaign: campaignId,
          limit: params.limit ?? PAGE_LIMIT,
          // Spec: the last lead's `id` of the previous page (distinct_contacts false).
          ...(params.startingAfter ? { starting_after: params.startingAfter } : {}),
        },
        mutating: false,
      },
      instantlyLeadPageSchema,
    );
  }

  async function listEmails(params: ListEmailsParams = {}) {
    await emailsLimiter.take();
    return request(
      {
        op: "listEmails",
        method: "GET",
        path: "/api/v2/emails",
        query: {
          limit: params.limit ?? PAGE_LIMIT,
          starting_after: params.startingAfter,
          search: params.search,
          lead: params.lead,
          campaign_id: params.campaignId,
          eaccount: params.eaccount,
          email_type: params.emailType,
          min_timestamp_created: params.minTimestampCreated,
          sort_order: params.sortOrder,
        },
        mutating: false,
      },
      instantlyEmailPageSchema,
    );
  }

  /**
   * GET /api/v2/emails/{id} (09 §U6c): one email with its To/Cc/Bcc, for the
   * post-send recipient check. The spec states the 20 req/min limit only for
   * the list endpoint; this read shares its limiter anyway (conservative).
   */
  async function getEmail(id: string): Promise<InstantlyEmail> {
    await emailsLimiter.take();
    return request(
      { op: "getEmail", method: "GET", path: `/api/v2/emails/${encodeURIComponent(id)}`, mutating: false },
      instantlyEmailSchema,
    );
  }

  /** GET /api/v2/leads/{id}. Null on 404 — the stop confirmation (09 §U6c) reads absence as removed. */
  async function getLead(id: string): Promise<InstantlyLead | null> {
    try {
      return await request(
        { op: "getLead", method: "GET", path: `/api/v2/leads/${encodeURIComponent(id)}`, mutating: false },
        instantlyLeadSchema,
      );
    } catch (error) {
      if (error instanceof InstantlyPermanentError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * GET /api/v2/accounts/analytics/daily: campaign emails sent per account per
   * date (09 §U6c S20, provider_daily_limit). The spec caps the range at 31
   * days and 200 accounts.
   */
  async function getAccountDailyAnalytics(params: {
    emails: string[];
    startDate: string;
    endDate: string;
  }): Promise<InstantlyAccountDailyAnalytics> {
    const path = "/api/v2/accounts/analytics/daily";
    const emails = [...new Set(params.emails.map((e) => e.trim()).filter(Boolean))];
    if (emails.length < 1 || emails.length > 200) {
      throw new InstantlyPermanentError(
        `Instantly getAccountDailyAnalytics: emails must be 1..200, got ${emails.length}`,
        { op: "getAccountDailyAnalytics", method: "GET", path, status: null },
        "validation",
      );
    }
    return request(
      {
        op: "getAccountDailyAnalytics",
        method: "GET",
        path,
        query: { start_date: params.startDate, end_date: params.endDate, emails },
        mutating: false,
      },
      instantlyAccountDailyAnalyticsSchema,
    );
  }

  function listWebhookEventTypes() {
    return request(
      { op: "listWebhookEventTypes", method: "GET", path: "/api/v2/webhooks/event-types", mutating: false },
      instantlyWebhookEventTypesSchema,
    );
  }

  function listWebhooks(params: { limit?: number; startingAfter?: string } = {}) {
    return request(
      {
        op: "listWebhooks",
        method: "GET",
        path: "/api/v2/webhooks",
        query: { limit: params.limit ?? PAGE_LIMIT, starting_after: params.startingAfter },
        mutating: false,
      },
      instantlyWebhookPageSchema,
    );
  }

  // ---- mutations (never retried here) ----------------------------------------

  /**
   * Subscribe a URL to events. Instantly has no signing secret: deliveries are
   * authenticated by the static `authHeader` we ask it to send. Its value never
   * appears in a returned object, a log line or an error message.
   */
  async function createWebhook(input: {
    targetUrl: string;
    eventType: string;
    name?: string;
    campaignId?: string | null;
    authHeader: { name: string; value: string };
  }): Promise<InstantlyWebhook> {
    const secret = input.authHeader.value;
    const ctx: ErrorContext = { op: "createWebhook", method: "POST", path: "/api/v2/webhooks", status: null };
    if (!/^https:\/\//.test(input.targetUrl)) {
      throw new InstantlyPermanentError("Instantly createWebhook: targetUrl must be https", ctx, "validation");
    }
    if (!input.authHeader.name.trim() || secret.length < 32) {
      throw new InstantlyPermanentError("Instantly createWebhook: an auth header of >= 32 chars is required", ctx, "validation");
    }
    try {
      return await request(
        {
          op: "createWebhook",
          method: "POST",
          path: "/api/v2/webhooks",
          body: {
            target_hook_url: input.targetUrl,
            event_type: input.eventType,
            name: input.name ?? null,
            campaign: input.campaignId ?? null,
            headers: { [input.authHeader.name]: secret },
          },
          mutating: true,
          fingerprint: { targetUrl: input.targetUrl, eventType: input.eventType },
        },
        instantlyWebhookConfigSchema,
      );
    } catch (error) {
      if (error instanceof Error) error.message = error.message.split(secret).join("[redacted]");
      throw error;
    }
  }

  function deleteWebhook(id: string): Promise<InstantlyWebhook> {
    return request(
      {
        op: "deleteWebhook",
        method: "DELETE",
        path: `/api/v2/webhooks/${encodeURIComponent(id)}`,
        mutating: true,
        fingerprint: { id },
      },
      instantlyWebhookConfigSchema,
    );
  }

  /** Asks Instantly to deliver a test payload to the webhook's URL. */
  function testWebhook(id: string): Promise<InstantlyWebhookTestResult> {
    return request(
      {
        op: "testWebhook",
        method: "POST",
        path: `/api/v2/webhooks/${encodeURIComponent(id)}/test`,
        body: {},
        mutating: true,
        fingerprint: { id },
      },
      instantlyWebhookTestResultSchema,
    );
  }

  async function enrollLead(input: EnrollLeadInput): Promise<EnrollLeadResult> {
    const path = "/api/v2/leads/add";
    const ctx: ErrorContext = { op: "enrollLead", method: "POST", path, status: null };
    const email = input.lead.email?.trim();
    if (!input.campaignId?.trim()) {
      throw new InstantlyPermanentError("Instantly enrollLead: campaignId is required", ctx, "validation");
    }
    if (!email) {
      throw new InstantlyPermanentError("Instantly enrollLead: lead.email is required", ctx, "validation");
    }

    const dedupe = input.dedupe ?? "workspace";
    const fingerprint = { campaignId: input.campaignId, email };
    const raw = await request(
      {
        op: "enrollLead",
        method: "POST",
        path,
        body: {
          campaign_id: input.campaignId,
          leads: [{ ...input.lead, email }],
          skip_if_in_workspace: dedupe === "workspace",
          skip_if_in_campaign: true,
          verify_leads_on_import: false,
        },
        mutating: true,
        fingerprint,
      },
      instantlyLeadsAddResponseSchema,
    );

    const created = raw.created_leads[0];
    if (raw.leads_uploaded === 1 && created) {
      return { outcome: "created", leadId: created.id, raw };
    }
    if (raw.leads_uploaded === 0 && raw.created_leads.length === 0) {
      if (raw.in_blocklist > 0) return { outcome: "skipped", reason: "blocklisted", raw };
      if (raw.invalid_email_count > 0) return { outcome: "skipped", reason: "invalid_email", raw };
      if (raw.incomplete_count > 0) return { outcome: "skipped", reason: "incomplete", raw };
      if (raw.duplicated_leads > 0 || raw.skipped_count > 0 || raw.duplicate_email_count > 0) {
        return { outcome: "skipped", reason: "already_enrolled", raw };
      }
    }
    // Accepted, but the counts do not say what happened to the lead.
    throw new InstantlyUncertainOutcomeError(
      `Instantly enrollLead: 200 with inconsistent counts (uploaded=${raw.leads_uploaded}, created=${raw.created_leads.length}, skipped=${raw.skipped_count}) — reconcile, do not resend`,
      { ...ctx, status: 200 },
      "unreadable_response",
      fingerprint,
    );
  }

  function pauseCampaign(id: string): Promise<InstantlyCampaign> {
    return request(
      {
        op: "pauseCampaign",
        method: "POST",
        path: `/api/v2/campaigns/${encodeURIComponent(id)}/pause`,
        mutating: true,
        fingerprint: { campaignId: id },
      },
      instantlyCampaignSchema,
    );
  }

  function activateCampaign(id: string): Promise<InstantlyCampaign> {
    return request(
      {
        op: "activateCampaign",
        method: "POST",
        path: `/api/v2/campaigns/${encodeURIComponent(id)}/activate`,
        mutating: true,
        fingerprint: { campaignId: id },
      },
      instantlyCampaignSchema,
    );
  }

  /** Creates a campaign. Instantly creates it as a draft; nothing sends until activated. */
  function createCampaign(input: CreateCampaignInput): Promise<InstantlyCampaignDetail> {
    const path = "/api/v2/campaigns";
    if (!input.name?.trim() || input.email_list.length === 0) {
      throw new InstantlyPermanentError(
        "Instantly createCampaign: name and a non-empty email_list are required",
        { op: "createCampaign", method: "POST", path, status: null },
        "validation",
      );
    }
    return request(
      {
        op: "createCampaign",
        method: "POST",
        path,
        body: input,
        mutating: true,
        fingerprint: { name: input.name },
      },
      instantlyCampaignDetailSchema,
    );
  }

  /**
   * PATCH /api/v2/campaigns/{id} with a new `sequences` value (09 §U6c). The
   * caller (instantly-sender-campaigns.ts --update) refuses unless the
   * campaign is paused and holds 0 leads: adding steps reactivates completed
   * leads. A mutation — never retried here; a 5xx/timeout is uncertain.
   */
  function updateCampaign(
    id: string,
    patch: { sequences: CreateCampaignInput["sequences"] },
  ): Promise<InstantlyCampaignDetail> {
    const path = `/api/v2/campaigns/${encodeURIComponent(id)}`;
    if (!id?.trim() || patch.sequences.length !== 1 || patch.sequences[0]!.steps.length === 0) {
      throw new InstantlyPermanentError(
        "Instantly updateCampaign: an id and exactly one sequence with steps are required",
        { op: "updateCampaign", method: "PATCH", path, status: null },
        "validation",
      );
    }
    return request(
      {
        op: "updateCampaign",
        method: "PATCH",
        path,
        body: { sequences: patch.sequences },
        mutating: true,
        fingerprint: { campaignId: id },
      },
      instantlyCampaignDetailSchema,
    );
  }

  /**
   * Sends a follow-up as a reply to an existing email, so it lands in the same
   * thread (U5). This SENDS mail — it is the engine-owned step >= 2.
   */
  function replyToEmail(input: ReplyToEmailInput): Promise<InstantlyEmail> {
    const path = "/api/v2/emails/reply";
    const ctx: ErrorContext = { op: "replyToEmail", method: "POST", path, status: null };
    const eaccount = input.eaccount?.trim();
    const replyTo = input.replyToUuid?.trim();
    if (!eaccount || !replyTo || !input.subject?.trim() || (!input.body.text && !input.body.html)) {
      throw new InstantlyPermanentError(
        "Instantly replyToEmail: eaccount, replyToUuid, subject and a body are required",
        ctx,
        "validation",
      );
    }
    return request(
      {
        op: "replyToEmail",
        method: "POST",
        path,
        body: {
          eaccount,
          reply_to_uuid: replyTo,
          subject: input.subject,
          body: input.body,
          ...(input.additionalRecipients?.length ? { additional_recipients: input.additionalRecipients } : {}),
        },
        mutating: true,
        fingerprint: { eaccount, replyToUuid: replyTo },
      },
      instantlyEmailSchema,
    );
  }

  /** Per-lead stop: Instantly has no per-lead pause, so a lead is removed. */
  function deleteLead(leadId: string): Promise<InstantlyLead> {
    return request(
      {
        op: "deleteLead",
        method: "DELETE",
        path: `/api/v2/leads/${encodeURIComponent(leadId)}`,
        mutating: true,
        fingerprint: { leadId },
      },
      instantlyLeadSchema,
    );
  }

  /** Cross-campaign stop: an email or a domain on the workspace block list. */
  function addBlockListEntry(value: string): Promise<InstantlyBlockListEntry> {
    const trimmed = value.trim();
    return request(
      {
        op: "addBlockListEntry",
        method: "POST",
        path: "/api/v2/block-lists-entries",
        body: { bl_value: trimmed },
        mutating: true,
        fingerprint: { value: trimmed },
      },
      instantlyBlockListEntrySchema,
    );
  }

  return {
    getCurrentWorkspace,
    listAccounts,
    listAllAccounts,
    getAccount,
    getWarmupAnalytics,
    listCampaigns,
    listAllCampaigns,
    getCampaign,
    findLeadInCampaign,
    listCampaignLeads,
    listEmails,
    getEmail,
    getLead,
    getAccountDailyAnalytics,
    listWebhookEventTypes,
    listWebhooks,
    enrollLead,
    createCampaign,
    updateCampaign,
    replyToEmail,
    pauseCampaign,
    activateCampaign,
    deleteLead,
    addBlockListEntry,
    createWebhook,
    deleteWebhook,
    testWebhook,
  };
}

export type InstantlyClient = ReturnType<typeof createInstantlyClient>;

export const INSTANTLY_READ_OPERATIONS = [
  "getCurrentWorkspace",
  "listAccounts",
  "listAllAccounts",
  "getAccount",
  "getWarmupAnalytics",
  "listCampaigns",
  "listAllCampaigns",
  "getCampaign",
  "findLeadInCampaign",
  "listCampaignLeads",
  "listEmails",
  "getEmail",
  "getLead",
  "getAccountDailyAnalytics",
  "listWebhookEventTypes",
  "listWebhooks",
] as const satisfies readonly (keyof InstantlyClient)[];

export const INSTANTLY_MUTATING_OPERATIONS = [
  "enrollLead",
  "createCampaign",
  "updateCampaign",
  "replyToEmail",
  "pauseCampaign",
  "activateCampaign",
  "deleteLead",
  "addBlockListEntry",
  "createWebhook",
  "deleteWebhook",
  "testWebhook",
] as const satisfies readonly (keyof InstantlyClient)[];

export type InstantlyReadClient = Pick<InstantlyClient, (typeof INSTANTLY_READ_OPERATIONS)[number]>;

/** A client with no mutating operations at all — for live checks and dashboards. */
export function createInstantlyReadClient(options: InstantlyClientOptions = {}): InstantlyReadClient {
  const full = createInstantlyClient(options);
  const read = {} as Record<string, unknown>;
  for (const name of INSTANTLY_READ_OPERATIONS) read[name] = full[name];
  return read as InstantlyReadClient;
}

// ---------------------------------------------------------------------------
// Per-account health (pure)
// ---------------------------------------------------------------------------

const VERDICT_RANK: Record<AccountHealthVerdict, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  unhealthy: 3,
};

/**
 * Health from the account's status codes and, optionally, its warmup aggregate.
 * The score threshold is policy, so the caller passes it (from settings); without
 * one the score is reported, not judged. A missing score is unknown, never 0.
 */
export function accountHealth(
  account: InstantlyAccount,
  warmup?: InstantlyWarmupAggregate | null,
  policy: { minWarmupScore?: number } = {},
): AccountHealth {
  let verdict: AccountHealthVerdict = "healthy";
  const reasons: string[] = [];
  const flag = (v: AccountHealthVerdict, reason: string) => {
    reasons.push(reason);
    if (VERDICT_RANK[v] > VERDICT_RANK[verdict]) verdict = v;
  };

  switch (account.status) {
    case 1:
      break;
    case 2:
      flag("unhealthy", "account_paused");
      break;
    case 3:
      flag("degraded", "account_maintenance_paused");
      break;
    case -1:
      flag("unhealthy", "account_connection_error");
      break;
    case -2:
      flag("unhealthy", "account_soft_bounce_error");
      break;
    case -3:
      flag("unhealthy", "account_sending_error");
      break;
    default:
      flag("unknown", `account_status_unknown(${account.status})`);
  }

  switch (account.warmup_status) {
    case 1:
      break;
    case 0:
      flag("degraded", "warmup_paused");
      break;
    case -1:
      flag("unhealthy", "warmup_banned");
      break;
    case -2:
      flag("degraded", "warmup_spam_folder_unknown");
      break;
    case -3:
      flag("unhealthy", "warmup_permanent_suspension");
      break;
    default:
      flag("unknown", `warmup_status_unknown(${account.warmup_status})`);
  }

  if (account.setup_pending) flag("unhealthy", "setup_pending");

  const score = warmup?.health_score ?? account.stat_warmup_score ?? null;
  if (score === null) {
    flag("unknown", "no_warmup_score");
  } else if (policy.minWarmupScore !== undefined && score < policy.minWarmupScore) {
    flag("degraded", `warmup_score_below_${policy.minWarmupScore}`);
  }

  return { email: account.email, verdict, reasons, warmupScore: score };
}
