// Research parsers, inputs, prices and evidence selection (09 §UR). Pure: no
// DB, no network. Fixtures are synthetic (src/lib/integrations/__fixtures__/apify).
// Run: pnpm test:research-parsers
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { formatClaimLines, formatSequenceApprovalMessages } from "@/lib/integrations/telegram-approval";
import { runOptionsQuery } from "@/lib/integrations/apify";
import { storedEvidenceItemSchema } from "@/lib/validation/jsonb";

import {
  MAX_RESEARCH_EVIDENCE,
  selectResearchEvidence,
  toStoredEvidenceItem,
  type ResearchEvidenceRow,
} from "./evidence";
import { capExposureUsd, estimateActualCostUsd, estimateMaxCostUsd } from "./prices";
import { adapterFor, RESEARCH_ADAPTERS, sanitizeActorInput, templateFor } from "./sources";
import { contentHash, linkedinIdentity, namesCompany, verbatimExcerpt } from "./text";
import type { ParseContext, ResearchTarget } from "./types";

const FIXTURES = join(process.cwd(), "src/lib/integrations/__fixtures__/apify");
function fixture(name: string): Record<string, unknown>[] {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>[];
}

const NOW = new Date("2026-09-26T12:00:00.000Z");
const TARGET: ResearchTarget = {
  leadId: "00000000-0000-4000-8000-000000000001",
  companyId: "00000000-0000-4000-8000-000000000002",
  leadLinkedinUrl: "https://www.linkedin.com/in/pat-fixture/",
  company: {
    name: "Acme Test Realty LLC",
    domain: "acme-test.example.com",
    linkedinUrl: "https://www.linkedin.com/company/acme-test-realty/",
    city: "Houston",
    country: "United States",
  },
};
const CTX: ParseContext = { target: TARGET, now: NOW, maxItemAgeDays: 365 };
const POLICY = { enabled: true, max_items: 5, max_charge_usd: 0.012 };

/** Every excerpt is a verbatim substring of the item text it came from. */
function assertVerbatim(excerpt: string, sourceTexts: string[]): void {
  assert.ok(
    sourceTexts.some((t) => t.includes(excerpt)),
    `excerpt is not a verbatim substring of any source text: ${excerpt.slice(0, 80)}`,
  );
}

describe("text helpers", () => {
  test("verbatimExcerpt keeps short text whole (trimmed) and cuts long text at a sentence boundary", () => {
    assert.equal(verbatimExcerpt("  Hello there. General Kenobi.  "), "Hello there. General Kenobi.");
    const long = `${"First sentence is here. ".repeat(60)}Tail without end`;
    const cut = verbatimExcerpt(long, 200)!;
    assert.ok(cut.length <= 200, `length ${cut.length}`);
    assert.ok(long.includes(cut));
    assert.ok(cut.endsWith("."));
    assert.equal(verbatimExcerpt("   "), null);
    assert.equal(verbatimExcerpt("x".repeat(1000), 100), null, "no boundary within 3×max → no excerpt");
  });

  test("contentHash normalises whitespace and case only", () => {
    assert.equal(contentHash("Hello  World"), contentHash("hello world"));
    assert.notEqual(contentHash("hello world"), contentHash("hello, world"));
    assert.match(contentHash("x"), /^[0-9a-f]{64}$/);
  });

  test("linkedinIdentity ignores query, trailing path and case", () => {
    assert.equal(linkedinIdentity("https://www.linkedin.com/in/Pat-Fixture?miniProfileUrn=x"), "in/pat-fixture");
    assert.equal(linkedinIdentity("https://www.linkedin.com/company/acme-test-realty/posts"), "company/acme-test-realty");
    assert.equal(linkedinIdentity("https://example.com/in/pat"), null);
  });

  test("namesCompany matches the name with or without a legal suffix, as whole words", () => {
    assert.ok(namesCompany("Acme Test Realty opens an office", "Acme Test Realty LLC"));
    assert.ok(!namesCompany("Acme Test Realtyco opens", "Acme Test Realty LLC"));
    assert.ok(!namesCompany("Houston prices rise", "Acme Test Realty LLC"));
  });
});

describe("li_person_post (harvestapi/linkedin-profile-posts)", () => {
  const items = fixture("synthetic-li-person-posts.json");
  const result = adapterFor("li_person_post").parse(items, CTX);

  test("maps id/linkedinUrl/content/postedAt.date and keeps only the target's posts", () => {
    assert.equal(result.rawCount, 6);
    assert.equal(result.candidates.length, 2);
    const first = result.candidates[0]!;
    assert.equal(first.source_type, "li_person_post");
    assert.equal(first.source_url, "https://www.linkedin.com/posts/pat-fixture_activity-7300000000000000001-abcd");
    assert.equal(first.published_at, "2026-09-10T12:00:00.000Z");
    assert.equal(first.title, null);
    assert.equal(first.excerpt, (items[0]!.content as string));
  });

  test("every excerpt is verbatim; a long post is cut at a sentence boundary", () => {
    const texts = items.map((i) => String(i.content ?? ""));
    for (const c of result.candidates) assertVerbatim(c.excerpt, texts);
    const long = result.candidates[1]!;
    assert.ok(long.excerpt.length <= 1200 && long.excerpt.length < (items[5]!.content as string).length);
    assert.ok(/[.!?]$/.test(long.excerpt));
  });

  test("drops: other author, no URL, no text, too old", () => {
    assert.deepEqual(result.drops, { other_author: 1, no_url: 1, no_text: 1, too_old: 1 });
  });

  test("input: target URL, maxPosts, 6months, no reposts/quotes/reactions/comments", () => {
    const input = adapterFor("li_person_post").buildInput(TARGET, POLICY, { maxPosts: 99 });
    assert.deepEqual(input, {
      maxPosts: 5,
      targetUrls: [TARGET.leadLinkedinUrl],
      postedLimit: "6months",
      includeReposts: false,
      includeQuotePosts: false,
      scrapeReactions: false,
      scrapeComments: false,
    });
  });
});

describe("li_company_post (same actor, company page)", () => {
  const items = fixture("synthetic-li-company-posts.json");
  const result = adapterFor("li_company_post").parse(items, CTX);
  test("keeps the company's own post, drops another company's", () => {
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.source_type, "li_company_post");
    assertVerbatim(result.candidates[0]!.excerpt, items.map((i) => String(i.content)));
    assert.deepEqual(result.drops, { other_author: 1 });
  });
  test("needs a company URL; falls back to the li_posts template", () => {
    const adapter = adapterFor("li_company_post");
    assert.equal(adapter.missingInput({ ...TARGET, company: { ...TARGET.company, linkedinUrl: null } }), "company has no LinkedIn company URL");
    const tpl = templateFor(adapter, { li_posts: { actor_id: "harvestapi/linkedin-profile-posts", input: {} } } as never);
    assert.equal(tpl?.key, "li_posts");
  });
});

describe("li_profile (harvestapi/linkedin-profile-scraper)", () => {
  const items = fixture("synthetic-li-profile.json");
  const result = adapterFor("li_profile").parse(items, CTX);
  test("headline, about and the current role's description, each verbatim, no date", () => {
    assert.deepEqual(result.candidates.map((c) => c.title), ["LinkedIn headline", "LinkedIn about", "Broker/Owner · Acme Test Realty"]);
    const p = items[0]!;
    assertVerbatim(result.candidates[0]!.excerpt, [String(p.headline)]);
    assertVerbatim(result.candidates[1]!.excerpt, [String(p.about)]);
    assert.ok(result.candidates.every((c) => c.published_at === null && c.source_url === "https://www.linkedin.com/in/pat-fixture"));
    assert.deepEqual(result.drops, { other_author: 1 });
  });
  test("input: mode without email, the lead's URL only, maxItems 1", () => {
    const adapter = adapterFor("li_profile");
    assert.deepEqual(adapter.buildInput(TARGET, POLICY, {}), {
      profileScraperMode: "Profile details no email ($4 per 1k)",
      urls: [TARGET.leadLinkedinUrl],
    });
    assert.equal(adapter.maxItems(POLICY), 1);
  });
});

describe("job_post (bebity/linkedin-jobs-scraper)", () => {
  const items = fixture("synthetic-jobs.json");
  const result = adapterFor("job_post").parse(items, CTX);
  test("maps jobUrl/title/publishedAt/description", () => {
    assert.equal(result.candidates.length, 1);
    const job = result.candidates[0]!;
    assert.equal(job.source_url, "https://www.linkedin.com/jobs/view/4400000001");
    assert.equal(job.title, "Transaction Coordinator");
    assert.equal(job.published_at, "2026-09-12T00:00:00.000Z");
    assert.equal(job.excerpt, items[0]!.description);
  });
  test("drops: other company, no URL, too old", () => {
    assert.deepEqual(result.drops, { other_company: 1, no_url: 1, too_old: 1 });
  });
  test("input: companyUrls, rows, Past Month, no paid company add-ons", () => {
    const input = adapterFor("job_post").buildInput(TARGET, POLICY, {});
    assert.deepEqual(input, {
      companyUrls: [TARGET.company.linkedinUrl],
      rows: 5,
      publishedAt: "r2592000",
      companyProfile: false,
      enrichCompany: false,
    });
  });
});

describe("google_review (compass/crawler-google-places)", () => {
  test("a place whose website is the company domain: reviews kept verbatim, no reviewer data", () => {
    const items = fixture("synthetic-google-places-match.json");
    const result = adapterFor("google_review").parse(items, CTX);
    assert.equal(result.candidates.length, 1);
    const r = result.candidates[0]!;
    assert.equal(r.source_type, "google_review");
    assert.equal(r.source_url, "https://www.google.com/maps/place/?q=place_id:ChIJFIXTURE0001", "no reviewUrl without personal data → the place URL");
    assert.equal(r.published_at, "2026-08-30T10:00:00.000Z");
    assert.equal(r.title, "Acme Test Realty");
    assertVerbatim(r.excerpt, ["Called twice about a listing and nobody called back for three days."]);
    assert.ok(!("name" in r.raw) && !("reviewerId" in r.raw) && !("reviewerUrl" in r.raw));
    assert.deepEqual(result.drops, { no_text: 1, too_old: 1 });
  });

  test("a place with another website: zero items and a note", () => {
    const result = adapterFor("google_review").parse(fixture("synthetic-google-places-mismatch.json"), CTX);
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(result.drops, { place_website_mismatch: 1 });
    assert.match(result.notes[0]!, /other-business\.example\.org ≠ company domain acme-test\.example\.com/);
  });

  test("input: name + 'City, Country', one place, newest, personal data OFF; maxItems 1", () => {
    const adapter = adapterFor("google_review");
    const input = adapter.buildInput(TARGET, { enabled: true, max_items: 10, max_charge_usd: 0.5 }, { scrapeReviewsPersonalData: true });
    assert.equal(input.scrapeReviewsPersonalData, false);
    assert.deepEqual(input.searchStringsArray, ["Acme Test Realty LLC"]);
    assert.equal(input.locationQuery, "Houston, United States");
    assert.equal(input.maxCrawledPlacesPerSearch, 1);
    assert.equal(input.maxReviews, 10);
    assert.equal(input.reviewsSort, "newest");
    assert.equal(adapter.maxItems(POLICY), 1);
    assert.equal(adapter.missingInput({ ...TARGET, company: { ...TARGET.company, city: null } }), "company has no city for the location query");
  });
});

describe("news (data_xplorer/google-news-scraper-fast)", () => {
  const items = fixture("synthetic-news.json");
  const result = adapterFor("news").parse(items, CTX);
  test("keeps an article naming the company; the excerpt is the description that names it", () => {
    assert.equal(result.candidates.length, 1);
    const n = result.candidates[0]!;
    assert.equal(n.source_url, "https://news.example.com/acme-test-realty-katy");
    assert.equal(n.excerpt, items[0]!.description);
    assert.equal(n.title, items[0]!.title);
    assert.equal(n.published_at, "2026-09-15T08:00:00.000Z");
  });
  test("drops: off-topic, no URL", () => {
    assert.deepEqual(result.drops, { news_off_topic: 1, no_url: 1 });
  });
  test("input: quoted name, maxArticles, US:en, decoded URLs, descriptions on, timeframe 1y", () => {
    const input = adapterFor("news").buildInput(TARGET, POLICY, {});
    assert.deepEqual(input.keywords, ['"Acme Test Realty LLC"']);
    assert.equal(input.maxArticles, 5);
    assert.equal(input.region_language, "US:en");
    assert.equal(input.decodeUrls, true);
    assert.equal(input.extractDescriptions, true);
    assert.equal(input.timeframe, "1y");
  });
});

describe("blog (apify/website-content-crawler)", () => {
  const items = fixture("synthetic-blog.json");
  const result = adapterFor("blog").parse(items, CTX);
  test("keeps an on-domain page's plain text verbatim, undated", () => {
    assert.equal(result.candidates.length, 1);
    const b = result.candidates[0]!;
    assert.equal(b.source_url, "https://acme-test.example.com/blog/spring-update");
    assert.equal(b.excerpt, items[0]!.text);
    assert.equal(b.title, "Spring update | Acme Test Realty");
    assert.equal(b.published_at, null);
  });
  test("drops: off-domain page, page with no text, a 404 page", () => {
    assert.deepEqual(result.drops, { off_domain: 1, no_text: 1, http_error: 1 });
  });
  test("input: /blog + /news, depth 1, cheerio, page caps", () => {
    const input = adapterFor("blog").buildInput(TARGET, { enabled: true, max_items: 4, max_charge_usd: 0.02 }, { crawlerType: "playwright:adaptive" });
    assert.deepEqual(input.startUrls, [{ url: "https://acme-test.example.com/blog" }, { url: "https://acme-test.example.com/news" }]);
    assert.equal(input.maxCrawlDepth, 1);
    assert.equal(input.crawlerType, "cheerio");
    assert.equal(input.maxCrawlPages, 4);
  });
});

describe("safety and cost", () => {
  test("credential-like template keys are never passed to an actor", () => {
    const { input, removed } = sanitizeActorInput({ cookie: "x", sessionCookie: "y", li_at: "z", maxPosts: 5, initialCookies: [] });
    assert.deepEqual(input, { maxPosts: 5 });
    assert.deepEqual(removed.sort(), ["cookie", "initialCookies", "li_at", "sessionCookie"]);
  });

  test("adapter order: person sources first, then company sources", () => {
    assert.deepEqual(
      RESEARCH_ADAPTERS.map((a) => `${a.sourceType}:${a.scope}`),
      ["li_person_post:lead", "li_profile:lead", "li_company_post:company", "job_post:company", "google_review:company", "news:company", "blog:company"],
    );
  });

  test("price table: worst-case estimates, unknown stays null", () => {
    assert.equal(estimateMaxCostUsd("li_person_post", 5), 0.01005);
    assert.equal(estimateMaxCostUsd("li_person_post", 0), 0.00105, "0-result query is charged");
    assert.equal(estimateMaxCostUsd("li_profile", 1), 0.004);
    assert.equal(estimateMaxCostUsd("job_post", 5), 0.0076);
    assert.equal(estimateMaxCostUsd("google_review", 10), 0.0112);
    assert.equal(estimateMaxCostUsd("news", 5), 0.02);
    assert.equal(estimateMaxCostUsd("blog", 4), null);
    assert.equal(estimateActualCostUsd("li_person_post", 2), 0.00405);
    assert.equal(estimateActualCostUsd("blog", 4), null);
    assert.equal(capExposureUsd(0.0112, 0.5), 0.0112);
    assert.equal(capExposureUsd(null, 0.02), 0.02, "unknown price → the provider cap is the exposure");
  });

  test("run options become query parameters", () => {
    assert.equal(runOptionsQuery({ maxItems: 5, maxTotalChargeUsd: 0.012 }), "?maxItems=5&maxTotalChargeUsd=0.012");
    assert.equal(runOptionsQuery(), "");
    assert.throws(() => runOptionsQuery({ maxTotalChargeUsd: 0 }));
  });
});

describe("evidence selection for qualify", () => {
  const row = (over: Partial<ResearchEvidenceRow>): ResearchEvidenceRow => ({
    id: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`,
    lead_id: null,
    source_type: "news",
    source_url: "https://news.example.com/a",
    title: "t",
    excerpt: "Acme Test Realty opened a second office.",
    published_at: "2026-09-15T08:00:00+00:00",
    fetched_at: "2026-09-25T08:00:00+00:00",
    ...over,
  });

  test("most recent first, stale fetches and too-old items out, per-source cap 3, total cap", () => {
    const rows = [
      row({ id: "00000000-0000-4000-8000-000000000011", source_type: "job_post", published_at: "2026-09-20T00:00:00+00:00" }),
      row({ id: "00000000-0000-4000-8000-000000000012", source_type: "news", published_at: "2026-09-21T00:00:00+00:00" }),
      row({ id: "00000000-0000-4000-8000-000000000013", source_type: "news", published_at: "2026-09-19T00:00:00+00:00" }),
      row({ id: "00000000-0000-4000-8000-000000000014", source_type: "news", published_at: "2026-09-18T00:00:00+00:00" }),
      row({ id: "00000000-0000-4000-8000-000000000015", source_type: "news", published_at: "2026-09-17T00:00:00+00:00" }),
      row({ id: "00000000-0000-4000-8000-000000000016", source_type: "blog", published_at: null }),
      row({ id: "00000000-0000-4000-8000-000000000017", source_type: "google_review", fetched_at: "2026-08-01T00:00:00+00:00" }),
      row({ id: "00000000-0000-4000-8000-000000000018", source_type: "li_person_post", published_at: "2024-01-01T00:00:00+00:00" }),
    ];
    const picked = selectResearchEvidence(rows, { now: NOW, maxItemAgeDays: 365, maxFetchedAgeDays: 30 });
    assert.deepEqual(
      picked.map((r) => r.id.slice(-2)),
      ["12", "11", "13", "14", "16"],
      "news capped at 3; undated blog last; 31-day-old fetch and 2024 post excluded",
    );
    const many = Array.from({ length: 20 }, (_, i) =>
      row({ id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, source_type: (["news", "blog", "job_post", "google_review", "li_person_post", "li_company_post", "li_profile"] as const)[i % 7] }),
    );
    assert.equal(selectResearchEvidence(many, { now: NOW, maxItemAgeDays: 365, maxFetchedAgeDays: 30 }).length, MAX_RESEARCH_EVIDENCE);
  });

  test("a stored item: source mapped, observation = the verbatim excerpt, provenance kept, schema-valid", () => {
    const r = row({ id: "00000000-0000-4000-8000-000000000021", source_type: "google_review", source_url: "https://www.google.com/maps/place/?q=place_id:X" });
    const stored = toStoredEvidenceItem(r)!;
    assert.deepEqual(stored, {
      source: "reviews",
      observation: r.excerpt,
      source_type: "google_review",
      evidence_item_id: r.id,
      url: r.source_url,
      published_at: "2026-09-15T08:00:00.000Z",
      fetched_at: "2026-09-25T08:00:00.000Z",
      title: "t",
    });
    assert.ok(storedEvidenceItemSchema.safeParse(stored).success);
    for (const [type, source] of [["li_person_post", "linkedin"], ["li_company_post", "linkedin"], ["li_profile", "linkedin"], ["job_post", "jobs"], ["news", "news"], ["blog", "blog"]] as const) {
      assert.equal(toStoredEvidenceItem(row({ source_type: type }))?.source, source);
    }
  });
});

describe("Telegram card: each cited item's own dates", () => {
  const qualification = {
    fit_score: 70,
    segment: "us-realestate",
    problem_hypothesis: "h",
    recommended_angle: "speed-to-lead",
    evidence_fetched_at: "2026-09-20T00:00:00.000Z",
    evidence_policy_version: 1,
    max_age_days: 30,
    evidence: [
      { id: "E1", observation: "Site observation." },
      { id: "E2", observation: "A job post excerpt.", fetched_at: "2026-09-25T00:00:00.000Z", published_at: "2026-09-12T00:00:00.000Z" },
    ],
    claims: [{ span: "x", kind: "prospect_fact" as const, evidence_ids: ["E1", "E2"] }],
  };

  test("claim lines: the site item shows the lead-level date, the research item its own fetch + publish dates", () => {
    const lines = formatClaimLines(qualification).join("\n");
    assert.match(lines, /← E1 · fetched 2026-09-20 · <i>Site observation/);
    assert.match(lines, /← E2 · fetched 2026-09-25 · published 2026-09-12 · <i>A job post excerpt/);
  });

  test("sequence card: per-item dates and the step's freshness from its oldest cited item", () => {
    const [card] = formatSequenceApprovalMessages(
      {
        steps: [
          { touch_id: "t1", step_no: 1, delay: 0, delay_unit: "days", offset_days: 0, source: "writer", subject: "s", body: "b", claims: [{ span: "b", kind: "prospect_fact", evidence_ids: ["E2"] }] },
          { touch_id: "t2", step_no: 2, delay: 7, delay_unit: "days", offset_days: 7, source: "writer", subject: null, body: "c", claims: [{ span: "c", kind: "inference", evidence_ids: ["E1", "E2"] }] },
        ],
        sequence_setting_version: 1,
      },
      { id: "l", first_name: "Pat", last_name: "Fixture", title: "Broker", email_status: "valid" },
      qualification,
      { name: "Acme Test Realty", domain: "acme-test.example.com" },
      NOW,
    );
    assert.match(card!, /← E2 · 2026-09-25 · published 2026-09-12/);
    assert.match(card!, /← E1 · 2026-09-20 ·/);
    assert.match(card!, /freshness: 1d \+ 0d ≤ 30d/, "step 1 cites only E2 (fetched 1 day ago)");
    assert.match(card!, /freshness: 6d \+ 7d ≤ 30d/, "step 2's oldest cited item is E1 (lead-level, 6 days)");
  });
});
