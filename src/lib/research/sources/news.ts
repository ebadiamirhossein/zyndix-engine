// data_xplorer/google-news-scraper-fast (09 §UR): news naming the company
// (news, per company).
//
// Input (input schema): keywords ("Use quotes for exact match"), maxArticles
// ("Maximum number of news to extract per keyword or topic"), region_language
// (default "US:en"), decodeUrls ("decodes Google News URLs to get the original
// article URLs"), timeframe enum 1h | 1d | 7d | 30d | 1y | all — DEFAULT "1h",
// so it is always set; extractDescriptions (default false) is switched on,
// since `description` is "extracted from the original source";
// extractImages off (unused).
// Output fields used (README): title, url, source, publishedAt (ISO),
// description.
//
// Kept only when the title or description names the company.

import { z } from "zod";

import { createCollector, httpUrl, isoDate, isTooOld, namesCompany, str, verbatimExcerpt } from "../text";
import type { ParseContext, ParseResult, SourceAdapter } from "../types";

export const newsItemSchema = z
  .object({
    title: z.string().optional().nullable(),
    url: z.string().optional().nullable(),
    source: z.string().optional().nullable(),
    publishedAt: z.union([z.string(), z.number()]).optional().nullable(),
    description: z.string().optional().nullable(),
  })
  .passthrough();

export function parseNews(items: unknown[], ctx: ParseContext): ParseResult {
  const c = createCollector(items.length);
  const name = ctx.target.company.name;
  for (const item of items) {
    const parsed = newsItemSchema.safeParse(item);
    if (!parsed.success) {
      c.drop("invalid_item");
      continue;
    }
    const article = parsed.data;
    const url = httpUrl(article.url);
    if (!url) {
      c.drop("no_url");
      continue;
    }
    const title = str(article.title);
    const description = str(article.description);
    if (!title && !description) {
      c.drop("no_text");
      continue;
    }
    const titleNames = title ? namesCompany(title, name) : false;
    const descriptionNames = description ? namesCompany(description, name) : false;
    if (!titleNames && !descriptionNames) {
      c.drop("news_off_topic");
      continue;
    }
    const published = isoDate(article.publishedAt);
    if (isTooOld(published, ctx.now, ctx.maxItemAgeDays)) {
      c.drop("too_old");
      continue;
    }
    // The excerpt is the text that names the company: the description when it does, else the headline.
    const excerpt = verbatimExcerpt(descriptionNames ? description! : title!);
    if (!excerpt) {
      c.drop("excerpt_unbounded");
      continue;
    }
    c.keep({
      source_type: "news",
      source_url: url,
      title,
      excerpt,
      published_at: published,
      raw: { url, source: article.source ?? null, publishedAt: article.publishedAt ?? null },
    });
  }
  return c.result();
}

export const newsAdapter: SourceAdapter = {
  sourceType: "news",
  scope: "company",
  templateKeys: ["news"],
  missingInput: (t) => (t.company.name.trim().length >= 3 ? null : "company name too short to search"),
  buildInput: (t, policy, base) => ({
    ...base,
    keywords: [`"${t.company.name.replace(/"/g, "")}"`],
    maxArticles: policy.max_items,
    region_language: "US:en",
    decodeUrls: true,
    extractDescriptions: true,
    extractImages: false,
    // "Last year": items older than research_policy.max_item_age_days are dropped at parse time.
    timeframe: "1y",
  }),
  maxItems: (policy) => policy.max_items,
  parse: parseNews,
};
