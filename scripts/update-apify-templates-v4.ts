/**
 * scripts/update-apify-templates-v4.ts — 09 §UR (Wave 1).
 *
 * apify_actor_templates v3 → v4: adds the research sources' actors and their
 * base inputs. The research adapters (src/lib/research/sources/*) always set
 * the target fields and the safety fields themselves (URLs, limits,
 * scrapeReviewsPersonalData:false, no reposts…), and strip any
 * credential-like key, so a template can only add harmless defaults.
 * site / tech / li_posts are unchanged (li_posts is also the person-posts
 * research source; li_company_posts runs the same actor on company pages).
 *
 * Actor ids and input field names are from each actor's input schema
 * (public build object, api.apify.com, read 2026-09-26) — see 07.
 *
 * Default is a dry run that prints the proposed value. `--apply` writes v4 —
 * only after the operator's OK. Guard: refuses unless the active version is v3.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";
import { apifyActorTemplatesSchema, type ApifyActorTemplates } from "../src/lib/validation/jsonb";

const CHANGED_BY = "wave-1-ur";

export const RESEARCH_TEMPLATES: Required<Pick<ApifyActorTemplates, "li_company_posts" | "li_profile" | "jobs" | "reviews" | "news" | "blog">> = {
  li_company_posts: { actor_id: "harvestapi/linkedin-profile-posts", input: {} },
  li_profile: { actor_id: "harvestapi/linkedin-profile-scraper", input: { profileScraperMode: "Profile details no email ($4 per 1k)" } },
  jobs: { actor_id: "bebity/linkedin-jobs-scraper", input: { publishedAt: "r2592000", companyProfile: false, enrichCompany: false } },
  reviews: {
    actor_id: "compass/crawler-google-places",
    input: { language: "en", reviewsSort: "newest", scrapeReviewsPersonalData: false, maxImages: 0, scrapeContacts: false },
  },
  news: {
    actor_id: "data_xplorer/google-news-scraper-fast",
    input: { region_language: "US:en", timeframe: "1y", decodeUrls: true, extractDescriptions: true, extractImages: false },
  },
  blog: { actor_id: "apify/website-content-crawler", input: { crawlerType: "cheerio", maxCrawlDepth: 1, saveHtml: false, saveMarkdown: false } },
};

export function buildTemplatesV4(v3: ApifyActorTemplates): ApifyActorTemplates {
  return apifyActorTemplatesSchema.parse({ ...v3, ...RESEARCH_TEMPLATES });
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const db = createServiceClient(url, key);
  const settings = createSettingsStore(db);
  const apply = process.argv.includes("--apply");

  const { data: current, error } = await db
    .from("settings")
    .select("version, value")
    .eq("key", "apify_actor_templates")
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(`read apify_actor_templates: ${error.message}`);
  if (current?.version !== 3) throw new Error(`apify_actor_templates is v${current?.version}, expected v3`);

  const v3 = apifyActorTemplatesSchema.parse(current.value);
  const v4 = buildTemplatesV4(v3);

  console.log("=== apify_actor_templates v3 → v4 (added keys) ===");
  for (const k of Object.keys(v4) as (keyof ApifyActorTemplates)[]) {
    if (JSON.stringify(v3[k]) !== JSON.stringify(v4[k])) console.log(`+ ${k}: ${JSON.stringify(v4[k])}`);
  }
  console.log(`unchanged: ${(Object.keys(v3) as (keyof ApifyActorTemplates)[]).filter((k) => JSON.stringify(v3[k]) === JSON.stringify(v4[k])).join(", ")}`);

  if (!apply) {
    console.log("\n(dry-run) Add --apply to write apify_actor_templates v4.");
    return;
  }
  const w = await settings.writeNewVersion(
    "apify_actor_templates",
    v4,
    CHANGED_BY,
    "UR: research sources — company posts, profile, jobs, Google reviews, news, blog",
  );
  console.log(`\nWROTE apify_actor_templates v${w.version}`);
}

if (process.argv[1]?.endsWith("update-apify-templates-v4.ts")) {
  main().catch((error: unknown) => {
    console.error("update-apify-templates-v4 FAILED:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
