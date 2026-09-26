// The seven research sources (09 §UR), in run order: person sources first
// (they are cheap and only this lead's), then company-level sources.

import type { ApifyActorTemplates } from "@/lib/validation/jsonb";
import type { EvidenceSourceType } from "@/types/enums";

import type { SourceAdapter } from "../types";

import { blogAdapter } from "./blog";
import { chargedReviews, googleReviewAdapter } from "./google-reviews";
import { jobPostAdapter } from "./jobs";
import { liCompanyPostAdapter, liPersonPostAdapter } from "./linkedin-posts";
import { liProfileAdapter } from "./linkedin-profile";
import { newsAdapter } from "./news";

export const RESEARCH_ADAPTERS: readonly SourceAdapter[] = [
  liPersonPostAdapter,
  liProfileAdapter,
  liCompanyPostAdapter,
  jobPostAdapter,
  googleReviewAdapter,
  newsAdapter,
  blogAdapter,
];

export function adapterFor(source: EvidenceSourceType): SourceAdapter {
  const adapter = RESEARCH_ADAPTERS.find((a) => a.sourceType === source);
  if (!adapter) throw new Error(`no research adapter for ${source}`);
  return adapter;
}

/** Items the actor charges for (the price table's per-item unit). */
export function chargedItemCount(source: EvidenceSourceType, items: unknown[]): number {
  return source === "google_review" ? chargedReviews(items) : items.length;
}

// Never pass cookies, sessions or credentials to an actor (never the
// operator's own LinkedIn account): any such key in a template is removed.
const CREDENTIAL_KEY_RE = /cookie|session|password|passwd|token|secret|li_at|credential|auth/i;

export function sanitizeActorInput(input: Record<string, unknown>): { input: Record<string, unknown>; removed: string[] } {
  const out: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (CREDENTIAL_KEY_RE.test(key)) removed.push(key);
    else out[key] = value;
  }
  return { input: out, removed };
}

/** The actor template for a source (first template key present), or null when none is configured. */
export function templateFor(
  adapter: SourceAdapter,
  templates: Partial<ApifyActorTemplates> | null,
): { key: string; actor_id: string; input: Record<string, unknown> } | null {
  if (!templates) return null;
  for (const key of adapter.templateKeys) {
    const t = templates[key];
    if (t && typeof t.actor_id === "string" && t.actor_id) return { key, actor_id: t.actor_id, input: t.input ?? {} };
  }
  return null;
}
