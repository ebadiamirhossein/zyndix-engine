// Research sources (09 §UR): shared types for the adapters, the runner and
// the qualify/claim-guard readers. Pure — no I/O.

import type { EvidenceSourceType } from "@/types/enums";

/** Who/what one research run targets. Built by enrich from the lead + company rows. */
export type ResearchTarget = {
  leadId: string;
  companyId: string;
  /** The lead's own LinkedIn profile URL (person sources). */
  leadLinkedinUrl: string | null;
  company: {
    name: string;
    domain: string | null;
    linkedinUrl: string | null;
    city: string | null;
    country: string | null;
  };
};

/** Everything an adapter's parse() needs to judge an item. */
export type ParseContext = {
  target: ResearchTarget;
  now: Date;
  maxItemAgeDays: number;
};

/**
 * One typed evidence item, before it is stored. `excerpt` is a verbatim
 * substring of the item's own text (a post, a review, a job description, a
 * headline): never a paraphrase, never re-spaced.
 */
export type EvidenceCandidate = {
  source_type: EvidenceSourceType;
  source_url: string;
  title: string | null;
  excerpt: string;
  published_at: string | null;
  /** The minimal fields used from the actor item (no reviewer identities). */
  raw: Record<string, unknown>;
};

export const DROP_REASONS = [
  "invalid_item",
  "no_url",
  "no_text",
  "too_old",
  "other_author",
  "other_company",
  "place_website_mismatch",
  "news_off_topic",
  "off_domain",
  "http_error",
  "excerpt_unbounded",
  "duplicate",
] as const;

export type DropReason = (typeof DROP_REASONS)[number];

export type ParseResult = {
  candidates: EvidenceCandidate[];
  drops: Partial<Record<DropReason, number>>;
  /** Items the actor returned (what Apify charges for), before any filter. */
  rawCount: number;
  /** Place-level notes (e.g. "place website example.org ≠ company domain"). */
  notes: string[];
};

/** research_policy.sources.<source_type> (validation/jsonb.ts). */
export type SourcePolicy = { enabled: boolean; max_items: number; max_charge_usd: number };

/** The template key in apify_actor_templates each source reads its actor id + base input from. */
export type TemplateKey = "li_posts" | "li_company_posts" | "li_profile" | "jobs" | "reviews" | "news" | "blog";

export type SourceAdapter = {
  sourceType: EvidenceSourceType;
  /** Company-level sources are researched once per company and reused across contacts. */
  scope: "lead" | "company";
  /** Template keys tried in order (li_company_post falls back to the li_posts actor). */
  templateKeys: TemplateKey[];
  /** Why this target cannot be researched by this source (missing URL/name/city), or null. */
  missingInput(target: ResearchTarget): string | null;
  /** The actor input: template base input, then the target + policy fields (which win). */
  buildInput(target: ResearchTarget, policy: SourcePolicy, baseInput: Record<string, unknown>): Record<string, unknown>;
  /** Apify run option `maxItems` (dataset items charged) for this source. */
  maxItems(policy: SourcePolicy): number;
  parse(items: unknown[], ctx: ParseContext): ParseResult;
};
