// apify/website-content-crawler (09 §UR): the company's own blog / news pages
// (blog, per company). The actor already crawls the site (the `site`
// template); here it starts at /blog and /news, one level deep.
//
// Input (input schema): startUrls ("By default, the Actor will also crawl
// sub-pages of these URLs"), maxCrawlPages, maxCrawlDepth ("The start URLs
// have depth 0, the pages linked directly from the start URLs have depth 1"),
// crawlerType enum incl. "cheerio" ("Raw HTTP client (Cheerio)"), maxResults.
// Output fields used (README example / dataset schema): url, text,
// metadata.title, crawl.httpStatusCode ("HTTP status code returned for the
// page"). The crawler has no publication date field: published_at
// is null for blog items.
//
// Pricing: no pay-per-event price (store: "Pay per usage") — est cost unknown.

import { z } from "zod";

import { createCollector, hostMatchesDomain, httpUrl, str, verbatimExcerpt } from "../text";
import type { ParseContext, ParseResult, SourceAdapter } from "../types";

export const blogPageItemSchema = z
  .object({
    url: z.string().optional().nullable(),
    text: z.string().optional().nullable(),
    markdown: z.string().optional().nullable(),
    metadata: z.object({ title: z.string().optional().nullable() }).passthrough().optional().nullable(),
    crawl: z.object({ httpStatusCode: z.number().optional().nullable() }).passthrough().optional().nullable(),
  })
  .passthrough();

export function parseBlogPages(items: unknown[], ctx: ParseContext): ParseResult {
  const c = createCollector(items.length);
  for (const item of items) {
    const parsed = blogPageItemSchema.safeParse(item);
    if (!parsed.success) {
      c.drop("invalid_item");
      continue;
    }
    const page = parsed.data;
    const url = httpUrl(page.url);
    if (!url) {
      c.drop("no_url");
      continue;
    }
    if (!hostMatchesDomain(url, ctx.target.company.domain)) {
      c.drop("off_domain");
      continue;
    }
    // A missing /news or /blog page is missing information: an error status, or a
    // "not found" page served with 200, is never evidence.
    const status = page.crawl?.httpStatusCode;
    if ((typeof status === "number" && status >= 400) || /\b404\b|not found/i.test(page.metadata?.title ?? "")) {
      c.drop("http_error");
      continue;
    }
    // Plain text (not markdown): the claim guard compares words, not markup.
    const text = str(page.text);
    if (!text) {
      c.drop("no_text");
      continue;
    }
    const excerpt = verbatimExcerpt(text);
    if (!excerpt) {
      c.drop("excerpt_unbounded");
      continue;
    }
    c.keep({
      source_type: "blog",
      source_url: url,
      title: str(page.metadata?.title),
      excerpt,
      published_at: null,
      raw: { url, title: page.metadata?.title ?? null },
    });
  }
  return c.result();
}

export const blogAdapter: SourceAdapter = {
  sourceType: "blog",
  scope: "company",
  templateKeys: ["blog"],
  missingInput: (t) => (t.company.domain ? null : "company has no domain"),
  buildInput: (t, policy, base) => ({
    ...base,
    startUrls: [{ url: `https://${t.company.domain}/blog` }, { url: `https://${t.company.domain}/news` }],
    maxCrawlPages: policy.max_items,
    maxResults: policy.max_items,
    maxCrawlDepth: 1,
    crawlerType: "cheerio",
    saveHtml: false,
  }),
  maxItems: (policy) => policy.max_items,
  parse: parseBlogPages,
};
