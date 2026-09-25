import { z } from "zod";

import { apolloOrgSchema, apolloPersonSchema } from "@/lib/validation/external";

export const apolloPaginationSchema = z
  .object({
    page: z.number().optional(),
    per_page: z.number().optional(),
    total_entries: z.number().optional(),
    total_pages: z.number().optional(),
  })
  .passthrough();

export const apolloPersonSearchItemSchema = apolloPersonSchema
  .extend({
    last_name_obfuscated: z.string().optional().nullable(),
    organization_id: z.string().optional().nullable(),
    organization: z
      .object({
        name: z.string().optional(),
        primary_domain: z.string().optional(),
      })
      .passthrough()
      .optional()
      .nullable(),
    has_email: z.boolean().optional(),
  })
  .passthrough();

export const apolloOrgSearchResponseSchema = z
  .object({
    organizations: z.array(apolloOrgSchema).default([]),
    pagination: apolloPaginationSchema.optional(),
  })
  .passthrough();

export const apolloPeopleSearchResponseSchema = z
  .object({
    people: z.array(apolloPersonSearchItemSchema).default([]),
    pagination: apolloPaginationSchema.optional(),
  })
  .passthrough();

export const apolloPeopleMatchResponseSchema = z
  .object({
    person: apolloPersonSchema.nullable().optional(),
    credits_consumed: z.number().optional(),
  })
  .passthrough();

/** Organization Enrichment: only the location fields the timezone fill consumes are validated. */
export const apolloOrgEnrichmentSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    primary_domain: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    postal_code: z.string().nullable().optional(),
    raw_address: z.string().nullable().optional(),
  })
  .passthrough();

export const apolloOrgEnrichResponseSchema = z
  .object({
    organization: apolloOrgEnrichmentSchema.nullable().optional(),
  })
  .passthrough();

export type ApolloSegmentQuery = {
  industry?: string[];
  employee_range?: string[];
  country?: string;
  titles?: string[];
  /** Apollo organization_not_locations — HQ exclusions */
  exclude_locations?: string[];
  /** Post-search name/domain filter when Apollo has no keyword-exclusion param */
  exclude_keywords?: string[];
};

export function mapEmployeeRangeToApollo(range: string): string {
  const [min, max] = range.split("-");
  if (!min || !max) {
    return range;
  }
  return `${min},${max}`;
}

export function mapCountryToApolloLocation(country: string): string {
  const normalized = country.trim().toUpperCase();
  if (normalized === "US" || normalized === "USA") {
    return "united states";
  }
  if (normalized === "LT") {
    return "lithuania";
  }
  return country.trim().toLowerCase();
}

export function isMaskedApolloEmail(email: string | null | undefined): boolean {
  if (!email) {
    return true;
  }
  const lower = email.toLowerCase();
  return (
    lower.includes("email_not_unlocked") ||
    lower.includes("not_unlocked@") ||
    lower.includes("@domain.com")
  );
}
