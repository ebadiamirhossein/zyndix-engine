// bebity/linkedin-jobs-scraper (09 §UR): the company's LinkedIn job posts
// (job_post, per company). No login (store page: "No LinkedIn account
// needed").
//
// Input (input schema): companyUrls, rows ("How many jobs to return per
// search (up to 1000)"), publishedAt enum "" | r2592000 | r604800 | r86400
// (Any Time / Past Month / Past Week / Past 24 hours). companyProfile and
// enrichCompany are switched off: we use none of their fields, and
// enrichCompany is a paid add-on.
// Output fields used (README): id, jobUrl, title, publishedAt ("2026-08-29"),
// description, companyUrl, companyName.

import { z } from "zod";

import { createCollector, httpUrl, isoDate, isTooOld, linkedinIdentity, str, verbatimExcerpt } from "../text";
import type { ParseContext, ParseResult, SourceAdapter } from "../types";

/** "Past Month" in the actor's publishedAt enum. */
export const JOBS_PUBLISHED_AT = "r2592000";

export const linkedinJobItemSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional().nullable(),
    jobUrl: z.string().optional().nullable(),
    title: z.string().optional().nullable(),
    publishedAt: z.union([z.string(), z.number()]).optional().nullable(),
    description: z.string().optional().nullable(),
    companyUrl: z.string().optional().nullable(),
    companyName: z.string().optional().nullable(),
  })
  .passthrough();

export function parseLinkedinJobs(items: unknown[], ctx: ParseContext): ParseResult {
  const c = createCollector(items.length);
  const target = linkedinIdentity(ctx.target.company.linkedinUrl);
  for (const item of items) {
    const parsed = linkedinJobItemSchema.safeParse(item);
    if (!parsed.success) {
      c.drop("invalid_item");
      continue;
    }
    const job = parsed.data;
    const url = httpUrl(job.jobUrl);
    if (!url) {
      c.drop("no_url");
      continue;
    }
    const text = str(job.description) ?? str(job.title);
    if (!text) {
      c.drop("no_text");
      continue;
    }
    // companyUrls filters the search, but a job of another company is never this company's evidence.
    // A numeric /company/<id> URL and a slug URL name the same page, so an exact
    // company-name match also counts.
    const company = linkedinIdentity(job.companyUrl);
    const sameName = str(job.companyName)?.trim().toLowerCase() === ctx.target.company.name.trim().toLowerCase();
    if (!target || (company !== null && company !== target && !sameName)) {
      c.drop("other_company");
      continue;
    }
    const published = isoDate(job.publishedAt);
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
      source_type: "job_post",
      source_url: url,
      title: str(job.title),
      excerpt,
      published_at: published,
      raw: { id: job.id ?? null, jobUrl: url, companyUrl: job.companyUrl ?? null, publishedAt: job.publishedAt ?? null },
    });
  }
  return c.result();
}

export const jobPostAdapter: SourceAdapter = {
  sourceType: "job_post",
  scope: "company",
  templateKeys: ["jobs"],
  missingInput: (t) => (linkedinIdentity(t.company.linkedinUrl)?.startsWith("company/") ? null : "company has no LinkedIn company URL"),
  buildInput: (t, policy, base) => ({
    ...base,
    companyUrls: [t.company.linkedinUrl!],
    rows: policy.max_items,
    publishedAt: JOBS_PUBLISHED_AT,
    companyProfile: false,
    enrichCompany: false,
  }),
  maxItems: (policy) => policy.max_items,
  parse: parseLinkedinJobs,
};
