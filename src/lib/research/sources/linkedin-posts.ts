// harvestapi/linkedin-profile-posts (09 §UR): person posts (li_person_post,
// per lead) and company-page posts (li_company_post, per company). One actor:
// its input schema describes targetUrls as "List of LinkedIn profile or
// company URLs to scrape". No cookies or account (store page: "No cookies or
// account required").
//
// Output fields used (README example item): id, linkedinUrl (the post URL),
// content, postedAt.date / postedAt.timestamp, author.linkedinUrl (carries a
// `?miniProfileUrn=` query), author.publicIdentifier / universalName.

import { z } from "zod";

import { createCollector, httpUrl, isoDate, isTooOld, linkedinIdentity, verbatimExcerpt, str } from "../text";
import type { ParseContext, ParseResult, SourceAdapter, SourcePolicy } from "../types";

export const linkedinPostItemSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional().nullable(),
    type: z.string().optional().nullable(),
    linkedinUrl: z.string().optional().nullable(),
    content: z.string().optional().nullable(),
    postedAt: z
      .union([
        z.object({ date: z.string().optional().nullable(), timestamp: z.number().optional().nullable() }).passthrough(),
        z.string(),
        z.number(),
      ])
      .optional()
      .nullable(),
    author: z
      .object({
        linkedinUrl: z.string().optional().nullable(),
        publicIdentifier: z.string().optional().nullable(),
        universalName: z.string().optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

/** Identity of a post's author, compared with the target's identity. */
function authorIdentities(author: z.infer<typeof linkedinPostItemSchema>["author"]): string[] {
  if (!author) return [];
  const out: string[] = [];
  const fromUrl = linkedinIdentity(author.linkedinUrl);
  if (fromUrl) out.push(fromUrl);
  for (const handle of [author.publicIdentifier, author.universalName]) {
    if (typeof handle === "string" && handle.trim()) {
      const h = handle.trim().toLowerCase();
      out.push(`in/${h}`, `company/${h}`);
    }
  }
  return out;
}

function baseInput(template: Record<string, unknown>, targetUrl: string, policy: SourcePolicy): Record<string, unknown> {
  return {
    ...template,
    targetUrls: [targetUrl],
    maxPosts: policy.max_items,
    // Input schema enum: any | 1h | 24h | week | month | 3months | 6months | year.
    postedLimit: "6months",
    includeReposts: false,
    includeQuotePosts: false,
    scrapeReactions: false,
    scrapeComments: false,
  };
}

export function parseLinkedinPosts(
  items: unknown[],
  ctx: ParseContext,
  targetUrl: string | null,
  sourceType: "li_person_post" | "li_company_post",
): ParseResult {
  const c = createCollector(items.length);
  const target = linkedinIdentity(targetUrl);
  for (const item of items) {
    const parsed = linkedinPostItemSchema.safeParse(item);
    if (!parsed.success) {
      c.drop("invalid_item");
      continue;
    }
    const post = parsed.data;
    const url = httpUrl(post.linkedinUrl);
    if (!url) {
      c.drop("no_url");
      continue;
    }
    const text = str(post.content);
    if (!text) {
      c.drop("no_text");
      continue;
    }
    if (!target || !authorIdentities(post.author).includes(target)) {
      c.drop("other_author");
      continue;
    }
    const posted = post.postedAt;
    const published =
      typeof posted === "object" && posted !== null ? (isoDate(posted.date) ?? isoDate(posted.timestamp)) : isoDate(posted);
    if (isTooOld(published, ctx.now, ctx.maxItemAgeDays)) {
      c.drop("too_old");
      continue;
    }
    const excerpt = verbatimExcerpt(text);
    if (!excerpt) {
      c.drop("excerpt_unbounded");
      continue;
    }
    c.keep({
      source_type: sourceType,
      source_url: url,
      title: null,
      excerpt,
      published_at: published,
      raw: { id: post.id ?? null, linkedinUrl: url, postedAt: published, author: post.author?.linkedinUrl ?? null },
    });
  }
  return c.result();
}

export const liPersonPostAdapter: SourceAdapter = {
  sourceType: "li_person_post",
  scope: "lead",
  templateKeys: ["li_posts"],
  missingInput: (t) => (linkedinIdentity(t.leadLinkedinUrl) ? null : "lead has no LinkedIn profile URL"),
  buildInput: (t, policy, base) => baseInput(base, t.leadLinkedinUrl!, policy),
  maxItems: (policy) => policy.max_items,
  parse: (items, ctx) => parseLinkedinPosts(items, ctx, ctx.target.leadLinkedinUrl, "li_person_post"),
};

export const liCompanyPostAdapter: SourceAdapter = {
  sourceType: "li_company_post",
  scope: "company",
  templateKeys: ["li_company_posts", "li_posts"],
  missingInput: (t) => (linkedinIdentity(t.company.linkedinUrl)?.startsWith("company/") ? null : "company has no LinkedIn company URL"),
  buildInput: (t, policy, base) => baseInput(base, t.company.linkedinUrl!, policy),
  maxItems: (policy) => policy.max_items,
  parse: (items, ctx) => parseLinkedinPosts(items, ctx, ctx.target.company.linkedinUrl, "li_company_post"),
};
