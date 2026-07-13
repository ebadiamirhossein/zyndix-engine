import { z } from "zod";

import {
  apolloOrgSearchResponseSchema,
  apolloPeopleMatchResponseSchema,
  apolloPeopleSearchResponseSchema,
  type ApolloSegmentQuery,
  mapCountryToApolloLocation,
  mapEmployeeRangeToApollo,
} from "@/lib/integrations/apollo-types";
import { parseOrThrow } from "@/lib/validation";
import { apolloOrgSchema, apolloPersonSchema } from "@/lib/validation/external";

const APOLLO_BASE_URL = "https://api.apollo.io/api/v1";

const PLAN_ERROR_STATUSES = new Set([401, 402, 403]);

const PLAN_ERROR_PATTERNS = [
  /not accessible with this api_key/i,
  /not available on your plan/i,
  /upgrade your plan/i,
  /master api key/i,
];

const apolloPersonSearchItemSchema = z
  .object({
    id: z.string(),
    first_name: z.string().optional().nullable(),
    last_name: z.string().optional().nullable(),
    last_name_obfuscated: z.string().optional().nullable(),
    title: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    linkedin_url: z.string().optional().nullable(),
    organization_id: z.string().optional().nullable(),
    organization: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .passthrough();

export class ApolloPlanError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Apollo plan/access error (${status}): ${body}`);
    this.name = "ApolloPlanError";
    this.status = status;
    this.body = body;
  }
}

export class ApolloApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Apollo API error (${status}): ${body}`);
    this.name = "ApolloApiError";
    this.status = status;
    this.body = body;
  }
}

let revealCallCount = 0;

export function getRevealCallCount(): number {
  return revealCallCount;
}

export function resetRevealCallCount(): void {
  revealCallCount = 0;
}

function requireApiKey(): string {
  const key = process.env.APOLLO_API_KEY;
  if (!key) {
    throw new Error("Missing APOLLO_API_KEY");
  }
  return key;
}

function maxRevealsPerRun(): number {
  const raw = process.env.APOLLO_MAX_REVEALS_PER_RUN ?? "5";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 5;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlanError(status: number, body: string): boolean {
  if (PLAN_ERROR_STATUSES.has(status)) {
    return true;
  }
  return PLAN_ERROR_PATTERNS.some((pattern) => pattern.test(body));
}

function logCreditMetadata(context: string, json: unknown): void {
  const credits =
    typeof json === "object" &&
    json !== null &&
    "credits_consumed" in json &&
    typeof (json as { credits_consumed: unknown }).credits_consumed === "number"
      ? (json as { credits_consumed: number }).credits_consumed
      : null;

  if (credits !== null) {
    console.log(`[apollo] ${context}: credits_consumed=${credits}`);
  } else {
    console.log(`[apollo] ${context}: ok (no credit metadata in response)`);
  }
}

function appendArray(params: URLSearchParams, key: string, values: string[]): void {
  for (const value of values) {
    params.append(`${key}[]`, value);
  }
}

/** Log-friendly snapshot of all outgoing query-string params. */
export function formatSearchParamsForLog(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length === 1 ? values[0]! : values;
  }
  return out;
}

/** Apollo filter endpoints expect POST with query-string params, not a JSON body. */
function buildSearchParams(fields: Record<string, string | number | boolean>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, String(value));
  }
  return params;
}

async function apolloRequest(
  path: string,
  params: URLSearchParams,
  context: string,
): Promise<unknown> {
  const apiKey = requireApiKey();
  const query = params.toString();
  const url = query ? `${APOLLO_BASE_URL}${path}?${query}` : `${APOLLO_BASE_URL}${path}`;

  if (context === "searchOrganizations") {
    console.log(
      `[apollo] searchOrganizations outgoing params: ${JSON.stringify(formatSearchParamsForLog(params))}`,
    );
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await sleep(500 * attempt);
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Cache-Control": "no-cache",
          accept: "application/json",
          "x-api-key": apiKey,
        },
      });

      const text = await response.text();
      let json: unknown = {};
      if (text) {
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = { raw: text };
        }
      }

      if (!response.ok) {
        const message =
          typeof json === "object" && json !== null
            ? String(
                (json as { error?: unknown; message?: unknown }).error ??
                  (json as { message?: unknown }).message ??
                  text,
              )
            : text || response.statusText;

        if (isPlanError(response.status, message)) {
          throw new ApolloPlanError(response.status, message);
        }

        if (attempt === 0 && response.status >= 500) {
          lastError = new ApolloApiError(response.status, message);
          continue;
        }

        throw new ApolloApiError(response.status, message);
      }

      logCreditMetadata(context, json);
      return json;
    } catch (error) {
      if (error instanceof ApolloPlanError) {
        throw error;
      }
      if (error instanceof ApolloApiError && attempt === 0) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Apollo ${context} failed`);
}

function buildOrgSearchParams(
  query: ApolloSegmentQuery,
  options?: { page?: number; perPage?: number },
): URLSearchParams {
  const params = buildSearchParams({
    page: options?.page ?? 1,
    per_page: options?.perPage ?? 25,
  });

  if (query.industry?.length) {
    appendArray(params, "q_organization_keyword_tags", query.industry);
  }
  if (query.employee_range?.length) {
    appendArray(
      params,
      "organization_num_employees_ranges",
      query.employee_range.map(mapEmployeeRangeToApollo),
    );
  }
  if (query.country) {
    appendArray(params, "organization_locations", [
      mapCountryToApolloLocation(query.country),
    ]);
  }
  if (query.exclude_locations?.length) {
    appendArray(
      params,
      "organization_not_locations",
      query.exclude_locations.map((loc) => loc.trim().toLowerCase()),
    );
  }

  return params;
}

export type ApolloClient = ReturnType<typeof createApolloClient>;

export type ApolloOrgSearchResult = {
  organizations: z.infer<typeof apolloOrgSchema>[];
  totalEntries: number;
  totalPages: number;
  page: number;
  perPage: number;
};

export function createApolloClient() {
  async function searchOrganizationsWithMeta(
    query: ApolloSegmentQuery,
    options?: { page?: number; perPage?: number },
  ): Promise<ApolloOrgSearchResult> {
    const params = buildOrgSearchParams(query, options);

    const json = await apolloRequest(
      "/mixed_companies/search",
      params,
      "searchOrganizations",
    );

    const response = parseOrThrow(
      apolloOrgSearchResponseSchema,
      json,
      "apollo:searchOrganizations",
    );

    const organizations = response.organizations.map((org) =>
      parseOrThrow(apolloOrgSchema, org, "apollo:organization"),
    );

    const page = options?.page ?? 1;
    const perPage = options?.perPage ?? 25;

    return {
      organizations,
      totalEntries: response.pagination?.total_entries ?? organizations.length,
      totalPages: response.pagination?.total_pages ?? 1,
      page,
      perPage,
    };
  }

  async function searchOrganizations(
    query: ApolloSegmentQuery,
    options?: { page?: number; perPage?: number },
  ) {
    const result = await searchOrganizationsWithMeta(query, options);
    return result.organizations;
  }

  async function searchPeople(
    orgIds: string[],
    titles: string[],
    options?: { page?: number; perPage?: number },
  ) {
    if (orgIds.length === 0) {
      return [];
    }

    const params = buildSearchParams({
      page: options?.page ?? 1,
      per_page: options?.perPage ?? 10,
      include_similar_titles: "true",
    });
    appendArray(params, "organization_ids", orgIds);
    appendArray(params, "person_titles", titles);

    const json = await apolloRequest("/mixed_people/api_search", params, "searchPeople");

    const response = parseOrThrow(
      apolloPeopleSearchResponseSchema,
      json,
      "apollo:searchPeople",
    );

    return response.people.map((person) =>
      parseOrThrow(apolloPersonSearchItemSchema, person, "apollo:person"),
    );
  }

  async function matchPersonRaw(
    apolloPersonId: string,
    options?: {
      revealPersonalEmails?: boolean;
      revealPhoneNumber?: boolean;
    },
  ): Promise<unknown> {
    const params = buildSearchParams({
      id: apolloPersonId,
      reveal_personal_emails: options?.revealPersonalEmails ?? false,
      reveal_phone_number: options?.revealPhoneNumber ?? false,
    });

    return apolloRequest("/people/match", params, "matchPersonRaw");
  }

  async function revealPersonEmail(apolloPersonId: string) {
    const cap = maxRevealsPerRun();
    if (revealCallCount >= cap) {
      console.warn(
        `[apollo] revealPersonEmail refused: APOLLO_MAX_REVEALS_PER_RUN=${cap} already reached`,
      );
      throw new Error(
        `Apollo reveal cap exceeded (max ${cap} per run). Refusing to burn more credits.`,
      );
    }

    revealCallCount += 1;

    const json = await matchPersonRaw(apolloPersonId, { revealPersonalEmails: true });

    const response = parseOrThrow(
      apolloPeopleMatchResponseSchema,
      json,
      "apollo:revealPersonEmail",
    );

    if (!response.person) {
      throw new Error(`Apollo reveal returned no person for id ${apolloPersonId}`);
    }

    return parseOrThrow(apolloPersonSchema, response.person, "apollo:revealedPerson");
  }

  return {
    searchOrganizations,
    searchOrganizationsWithMeta,
    searchPeople,
    matchPersonRaw,
    revealPersonEmail,
  };
}
