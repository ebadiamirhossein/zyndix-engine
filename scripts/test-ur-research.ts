/**
 * scripts/test-ur-research.ts — 09 §UR DoD (Wave 1): research sources through
 * the real enrich and qualify stages and the real claim-guard context loader.
 *
 * SAFETY CONTRACT
 *   - Synthetic fixtures only (`*.example.com` companies tagged ur-fixture-<ts>,
 *     `ur-pat-*` LinkedIn URLs). Stages are scoped to fixture lead ids; no real
 *     prospect is selected.
 *   - Lead states move only through lib/state.
 *   - Apify and Anthropic are mocked (synthetic dataset items from
 *     src/lib/integrations/__fixtures__/apify). A fetch guard fails any network
 *     call other than Supabase. Zero spend.
 *   - research_policy, apify_actor_templates (v4 shape), evidence_policy and
 *     cta_variants are pinned in-process; NO settings row is written. Other
 *     settings are read live.
 *   - Cleanup is scoped to the ids this run created; the run asserts the row
 *     counts (incl. research_runs, evidence_items) are identical before and after.
 *
 * Run ONLY through the DB lock: pnpm exec tsx scripts/with-db-lock.ts pnpm -s test:research
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import type { AnthropicClient } from "../src/lib/integrations/anthropic";
import type { ApifyClient, ApifyRunOptions } from "../src/lib/integrations/apify";
import { runResearchForLeads } from "../src/lib/research/run";
import { createSettingsStore } from "../src/lib/settings/core";
import { loadClaimContext, runClaimCheck } from "../src/lib/stages/draft/claims-context";
import { runEnrichStage } from "../src/lib/stages/enrich/core";
import { runQualifyStage } from "../src/lib/stages/qualify/core";
import { createStateStore } from "../src/lib/state/core";
import { storedEvidenceItemSchema, type ResearchPolicy } from "../src/lib/validation/jsonb";
import type { Claim } from "../src/lib/validation/llm";
import type { Database, Json } from "../src/types/database";
import type { DatabaseWithWave1 } from "../src/types/database-extensions";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const raw = createServiceClient(url, key);
const db = raw as SupabaseClient<Database>;
const wdb = raw as unknown as SupabaseClient<DatabaseWithWave1>;
const state = createStateStore(db);
const settings = createSettingsStore(db);

const STAMP = Date.now();
const TAG = `ur-fixture-${STAMP}`;
const APPROVED = "Happy to write up what I'd change, if that's useful.";
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const network: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = String(input instanceof Request ? input.url : input);
  if (target.startsWith(url)) return realFetch(input, init);
  network.push(target);
  throw new Error(`unexpected network call: ${target}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Pinned settings
// ---------------------------------------------------------------------------

const BASE_POLICY: ResearchPolicy = {
  enabled: true,
  max_cost_usd_per_lead: 0.1,
  reuse_days: 14,
  max_item_age_days: 365,
  sources: {
    li_person_post: { enabled: true, max_items: 5, max_charge_usd: 0.012 },
    li_company_post: { enabled: true, max_items: 5, max_charge_usd: 0.012 },
    li_profile: { enabled: true, max_items: 1, max_charge_usd: 0.005 },
    job_post: { enabled: true, max_items: 5, max_charge_usd: 0.01 },
    // compass/crawler-google-places: minimalMaxTotalChargeUsd 0.5 (Apify actor object).
    google_review: { enabled: true, max_items: 10, max_charge_usd: 0.5 },
    news: { enabled: true, max_items: 5, max_charge_usd: 0.021 },
    blog: { enabled: true, max_items: 4, max_charge_usd: 0.02 },
  },
};

const TEMPLATES_V4 = {
  site: { actor_id: "apify/website-content-crawler", input: { saveHtml: false, crawlerType: "playwright:adaptive", saveMarkdown: true, maxCrawlDepth: 2, maxCrawlPages: 12 } },
  tech: { actor_id: "tugelbay/website-tech-stack-detector", input: {} },
  li_posts: { actor_id: "harvestapi/linkedin-profile-posts", input: { maxPosts: 5 } },
  li_company_posts: { actor_id: "harvestapi/linkedin-profile-posts", input: {} },
  li_profile: { actor_id: "harvestapi/linkedin-profile-scraper", input: {} },
  jobs: { actor_id: "bebity/linkedin-jobs-scraper", input: {} },
  // A credential-like key in a template must never reach the actor.
  reviews: { actor_id: "compass/crawler-google-places", input: { language: "en", cookies: "must-be-removed" } },
  news: { actor_id: "data_xplorer/google-news-scraper-fast", input: {} },
  blog: { actor_id: "apify/website-content-crawler", input: { saveMarkdown: false } },
};

let researchPolicy: ResearchPolicy | "missing" = "missing";

async function getActiveSetting(k: string): Promise<{ version: number; value: unknown }> {
  if (k === "research_policy") {
    if (researchPolicy === "missing") throw new Error('No active setting found for key "research_policy"');
    return { version: 1, value: researchPolicy };
  }
  if (k === "apify_actor_templates") return { version: 4, value: TEMPLATES_V4 };
  if (k === "evidence_policy") return { version: 1, value: { max_age_days: 30 } };
  if (k === "cta_variants") {
    return {
      version: 3,
      value: { variants: [{ id: "reply", active: true, text: `end with exactly: "${APPROVED}"`, approved_lines: [APPROVED] }] },
    };
  }
  return settings.getActiveSetting(k as never);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Fixture = { leadId: string; companyId: string; name: string; domain: string; companySlug: string; leadSlug: string };
const created: Fixture[] = [];
const companies = new Map<string, { id: string; name: string; domain: string; slug: string }>();

async function company(label: string, opts: { city?: string | null } = {}) {
  const n = companies.size + 1;
  const name = `UR Fixture Realty ${String.fromCharCode(64 + n)}`; // A, B, C… (no digits in the name)
  const domain = `${TAG}-${n}.example.com`;
  const slug = `ur-fixture-${STAMP}-${n}`;
  const { data, error } = await db
    .from("companies")
    .insert({
      name,
      domain,
      segment: "us-realestate",
      country: "United States",
      city: opts.city === undefined ? "Houston" : opts.city,
      timezone: "America/Chicago",
      status: "new",
      linkedin_url: `https://www.linkedin.com/company/${slug}`,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`company ${label}: ${error?.message}`);
  const c = { id: data.id, name, domain, slug };
  companies.set(label, c);
  return c;
}

async function lead(companyLabel: string, n: number): Promise<Fixture> {
  const c = companies.get(companyLabel)!;
  const leadSlug = `ur-pat-${STAMP}-${companies.size}-${n}`;
  const { data, error } = await db
    .from("leads")
    .insert({
      company_id: c.id,
      first_name: "Pat",
      last_name: "Fixture",
      title: "Broker",
      email: `pat${n}@${c.domain}`,
      linkedin_url: `https://www.linkedin.com/in/${leadSlug}`,
      timezone: "America/Chicago",
      state: "sourced",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`lead: ${error?.message}`);
  const f = { leadId: data.id, companyId: c.id, name: c.name, domain: c.domain, companySlug: c.slug, leadSlug };
  created.push(f);
  return f;
}

// ---------------------------------------------------------------------------
// Apify mock: synthetic fixtures rewritten for the fixture company / lead
// ---------------------------------------------------------------------------

function fixtureItems(file: string, c: { name: string; domain: string; slug: string }, leadSlug: string | null): Record<string, unknown>[] {
  let text = readFileSync(resolve(process.cwd(), "src/lib/integrations/__fixtures__/apify", file), "utf8");
  text = text
    .replaceAll("acme-test.example.com", c.domain)
    .replaceAll("acme-test-realty", c.slug)
    .replaceAll("Acme Test Realty", c.name);
  if (leadSlug) text = text.replaceAll("pat-fixture", leadSlug);
  return JSON.parse(text) as Record<string, unknown>[];
}

type StartCall = { actorId: string; input: Record<string, unknown>; options: ApifyRunOptions | undefined; source: string };
const mock = {
  runAndWait: [] as { actorId: string; input: Record<string, unknown> }[],
  starts: [] as StartCall[],
  /** source → "fail" (run FAILED) | "empty" (no items) | "throw" (startRun rejects) | "mismatch" (other place). */
  behaviour: new Map<string, "fail" | "empty" | "throw" | "mismatch">(),
  datasets: new Map<string, { status: string; items: Record<string, unknown>[] }>(),
};

function sourceOf(actorId: string, input: Record<string, unknown>): string {
  if (actorId === "harvestapi/linkedin-profile-posts") {
    return String((input.targetUrls as string[])[0]).includes("/company/") ? "li_company_post" : "li_person_post";
  }
  return (
    {
      "harvestapi/linkedin-profile-scraper": "li_profile",
      "bebity/linkedin-jobs-scraper": "job_post",
      "compass/crawler-google-places": "google_review",
      "data_xplorer/google-news-scraper-fast": "news",
      "apify/website-content-crawler": "blog",
    } as Record<string, string>
  )[actorId] ?? "unknown";
}

function companyFor(input: Record<string, unknown>) {
  const blob = JSON.stringify(input);
  for (const c of companies.values()) if (blob.includes(c.slug) || blob.includes(c.domain) || blob.includes(c.name)) return c;
  for (const f of created) if (blob.includes(f.leadSlug)) return [...companies.values()].find((c) => c.id === f.companyId)!;
  throw new Error(`mock apify: no fixture company in input ${blob.slice(0, 200)}`);
}

function leadSlugFor(input: Record<string, unknown>): string | null {
  const blob = JSON.stringify(input);
  return created.find((f) => blob.includes(f.leadSlug))?.leadSlug ?? null;
}

let runSeq = 0;
const apify = {
  // Legacy enrich slots (site / tech / li_posts).
  async runAndWait(actorId: string, input: Record<string, unknown>) {
    mock.runAndWait.push({ actorId, input });
    const domains = ((input.startUrls as { url: string }[] | undefined)?.map((u) => u.url) ?? (input.urls as string[] | undefined) ?? []).map((u) =>
      u.replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    );
    const items =
      actorId === "harvestapi/linkedin-profile-posts"
        ? []
        : domains.map((d) =>
            actorId === "tugelbay/website-tech-stack-detector"
              ? { url: `https://${d}`, signals: { hasChatWidget: false } }
              : { url: `https://${d}/`, text: "Home. Serving Houston buyers and sellers. Contact our team." },
          );
    return { runId: `mock-legacy-${++runSeq}`, actorId, status: "SUCCEEDED", datasetId: null, durationMs: 1, itemCount: items.length, items };
  },
  async runAndWaitWith429Backoff(actorId: string, input: Record<string, unknown>) {
    return apify.runAndWait(actorId, input);
  },
  // Research runs.
  async startRun(actorId: string, input: Record<string, unknown>, options?: ApifyRunOptions): Promise<string> {
    const source = sourceOf(actorId, input);
    mock.starts.push({ actorId, input, options, source });
    const behaviour = mock.behaviour.get(source);
    if (behaviour === "throw") throw new Error("Apify API error (402): mock: not enough credit");
    const c = companyFor(input);
    const slug = leadSlugFor(input);
    const file = {
      li_person_post: "synthetic-li-person-posts.json",
      li_company_post: "synthetic-li-company-posts.json",
      li_profile: "synthetic-li-profile.json",
      job_post: "synthetic-jobs.json",
      google_review: behaviour === "mismatch" ? "synthetic-google-places-mismatch.json" : "synthetic-google-places-match.json",
      news: "synthetic-news.json",
      blog: "synthetic-blog.json",
    }[source]!;
    const runId = `mock-run-${++runSeq}`;
    mock.datasets.set(runId, {
      status: behaviour === "fail" ? "FAILED" : "SUCCEEDED",
      items: behaviour === "empty" || behaviour === "fail" ? [] : fixtureItems(file, c, slug),
    });
    return runId;
  },
  async waitForRun(runId: string) {
    const d = mock.datasets.get(runId)!;
    return { id: runId, status: d.status, defaultDatasetId: `ds-${runId}` };
  },
  async getDatasetItems(datasetId: string) {
    return mock.datasets.get(datasetId.replace(/^ds-/, ""))!.items;
  },
} as unknown as ApifyClient;

// ---------------------------------------------------------------------------
// Anthropic mock (qualifier)
// ---------------------------------------------------------------------------

const qualifierInputs: string[] = [];
const anthropic = {
  async complete(params: { user: string }) {
    qualifierInputs.push(params.user);
    return {
      text: JSON.stringify({
        fit_score: 78,
        segment: "us-realestate",
        problem_hypothesis: "Client emails land in one shared inbox that a new hire is being recruited to own.",
        evidence: [
          { source: "website", observation: "Homepage says the team serves Houston buyers and sellers." },
          { source: "linkedin", observation: "The broker's own post says the inbox has doubled since spring." },
        ],
        triggers: [],
        visible_tools: ["none_detected"],
        recommended_angle: "speed-to-lead",
        disqualify_reason: null,
      }),
      model: "mock",
      inputTokens: 1,
      outputTokens: 1,
      estCostUsd: 0,
    };
  },
} as unknown as AnthropicClient;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function runsFor(companyId: string) {
  const { data, error } = await wdb.from("research_runs").select("*").eq("company_id", companyId).order("created_at");
  if (error) throw new Error(`research_runs: ${error.message}`);
  return data ?? [];
}
async function itemsFor(companyId: string) {
  const { data, error } = await wdb.from("evidence_items").select("*").eq("company_id", companyId);
  if (error) throw new Error(`evidence_items: ${error.message}`);
  return data ?? [];
}
async function researchEvent(leadId: string) {
  const { data } = await db.from("lead_events").select("detail").eq("lead_id", leadId).eq("event", "research_completed").order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data?.detail as { sources?: Record<string, string>; notes?: string[] } | undefined;
}
async function leadState(id: string) {
  return (await state.getLead(id)).state;
}
/** Research startRun calls for one company: its company-level runs and its leads' person runs. */
function startsFor(companyId: string, source?: string) {
  const c = [...companies.values()].find((x) => x.id === companyId)!;
  const needles = [c.slug, c.domain, c.name, ...created.filter((f) => f.companyId === companyId).map((f) => f.leadSlug)];
  return mock.starts.filter((s) => {
    const blob = JSON.stringify(s.input);
    return needles.some((n) => blob.includes(n)) && (!source || s.source === source);
  });
}
const enrichDeps = () => ({ db, apify, getActiveSetting, transition: state.transition });

// ---------------------------------------------------------------------------
// Counts + cleanup
// ---------------------------------------------------------------------------

const COUNTED = ["companies", "leads", "lead_events", "qualification", "qualification_history", "enrichment_payloads", "research_runs", "evidence_items"] as const;
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of COUNTED) {
    const { count, error } = await wdb.from(t as "research_runs").select("id", { count: "exact", head: true });
    if (error) throw new Error(`count ${t}: ${error.message}`);
    out[t] = count ?? 0;
  }
  return out;
}

async function cleanup(): Promise<void> {
  const leadIds = created.map((f) => f.leadId);
  const companyIds = [...companies.values()].map((c) => c.id);
  if (companyIds.length === 0) return;
  for (const t of ["evidence_items", "research_runs"] as const) {
    const { error } = await wdb.from(t).delete().in("company_id", companyIds);
    if (error) throw new Error(`cleanup ${t}: ${error.message}`);
  }
  if (leadIds.length > 0) {
    for (const t of ["lead_events", "qualification_history", "qualification", "enrichment_payloads"] as const) {
      const { error } = await db.from(t).delete().in("lead_id", leadIds);
      if (error) throw new Error(`cleanup ${t}: ${error.message}`);
    }
    const { error: le } = await db.from("leads").delete().in("id", leadIds);
    if (le) throw new Error(`cleanup leads: ${le.message}`);
  }
  const { error: ce } = await db.from("companies").delete().in("id", companyIds);
  if (ce) throw new Error(`cleanup companies: ${ce.message}`);
  console.log(`\nCleanup: removed ${leadIds.length} fixture leads, ${companyIds.length} companies and their rows.`);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const EXPECTED_MAX_ITEMS: Record<string, number> = { li_person_post: 5, li_company_post: 5, li_profile: 1, job_post: 5, google_review: 1, news: 5, blog: 4 };

async function main(): Promise<void> {
  const before = await counts();
  console.log(`BEFORE ${JSON.stringify(before)}\n`);

  try {
    // -----------------------------------------------------------------------
    console.log("--- 1. research_policy missing / disabled → zero Apify research calls ---");
    await company("E");
    const e1 = await lead("E", 1);
    researchPolicy = "missing";
    const disabled = await runResearchForLeads({ db: wdb, apify, getActiveSetting }, []);
    const enrichMissing = await runEnrichStage(enrichDeps(), { leadIds: [e1.leadId] });
    assert("missing policy: runner reports disabled", !disabled.enabled && disabled.apify_calls === 0 && /research_policy unavailable/.test(disabled.reason ?? ""), disabled.reason ?? "");
    assert("missing policy: enrich made zero research startRun calls", mock.starts.length === 0 && enrichMissing.research === null);
    assert(
      "missing policy: the legacy li_posts slot still runs (site + tech + li_posts)",
      mock.runAndWait.map((r) => r.actorId).sort().join() === ["apify/website-content-crawler", "harvestapi/linkedin-profile-posts", "tugelbay/website-tech-stack-detector"].join(),
      mock.runAndWait.map((r) => r.actorId).join(),
    );
    researchPolicy = { ...BASE_POLICY, enabled: false };
    const off = await runResearchForLeads({ db: wdb, apify, getActiveSetting }, [
      { leadId: e1.leadId, companyId: e1.companyId, leadLinkedinUrl: null, company: { name: e1.name, domain: e1.domain, linkedinUrl: null, city: "Houston", country: "United States" } },
    ]);
    assert("enabled=false: zero calls, zero rows", !off.enabled && off.apify_calls === 0 && mock.starts.length === 0 && (await runsFor(e1.companyId)).length === 0);

    // -----------------------------------------------------------------------
    console.log("\n--- 2. two contacts of one company in one enrich batch ---");
    researchPolicy = BASE_POLICY;
    mock.runAndWait.length = 0;
    await company("A");
    const a1 = await lead("A", 1);
    const a2 = await lead("A", 2);
    const enrichA = await runEnrichStage(enrichDeps(), { leadIds: [a1.leadId, a2.leadId] });
    for (const source of ["li_company_post", "job_post", "google_review", "news", "blog"]) {
      const n = startsFor(a1.companyId, source).length;
      assert(`batch: exactly one ${source} run for the company (mock count = 1)`, n === 1, String(n));
    }
    assert("batch: person sources ran once per lead (2 × li_person_post, 2 × li_profile)", startsFor(a1.companyId, "li_person_post").length === 2 && startsFor(a1.companyId, "li_profile").length === 2);
    assert(
      "batch: every run passes maxTotalChargeUsd = the source's max_charge_usd and maxItems",
      mock.starts.every(
        (s) =>
          s.options?.maxTotalChargeUsd === BASE_POLICY.sources[s.source as keyof ResearchPolicy["sources"]].max_charge_usd &&
          s.options?.maxItems === EXPECTED_MAX_ITEMS[s.source],
      ),
      JSON.stringify(mock.starts.map((s) => [s.source, s.options])),
    );
    assert("batch: no credential-like key reached an actor", mock.starts.every((s) => !JSON.stringify(Object.keys(s.input)).match(/cookie/i)));
    assert(
      "batch: the legacy li_posts run is replaced by research (never paid twice)",
      mock.runAndWait.every((r) => r.actorId !== "harvestapi/linkedin-profile-posts") && mock.runAndWait.length === 2,
      mock.runAndWait.map((r) => r.actorId).join(),
    );
    const runsA = await runsFor(a1.companyId);
    const byStatus = (s: string) => runsA.filter((r) => r.status === s).length;
    assert("batch: 9 runs succeeded, 5 company-level reuse rows for the second contact", byStatus("succeeded") === 9 && byStatus("reused") === 5, JSON.stringify(runsA.map((r) => `${r.source_type}:${r.status}`)));
    assert(
      "batch: reuse rows point at the one company run",
      runsA.filter((r) => r.status === "reused").every((r) => r.lead_id === a2.leadId && runsA.some((o) => o.id === r.reused_run_id && o.status === "succeeded" && o.source_type === r.source_type)),
    );
    assert(
      "batch: known-price runs carry an estimate; the blog run's cost is unknown (null, not 0)",
      runsA.filter((r) => r.status === "succeeded" && r.source_type !== "blog").every((r) => r.est_cost_usd !== null && Number(r.est_cost_usd) > 0) &&
        runsA.filter((r) => r.source_type === "blog" && r.status === "succeeded").every((r) => r.est_cost_usd === null),
    );
    const itemsA = await itemsFor(a1.companyId);
    const companyItems = itemsA.filter((i) => i.lead_id === null);
    assert(
      "batch: company-level items have lead_id null; person items belong to their lead",
      companyItems.length > 0 &&
        itemsA.filter((i) => i.source_type === "li_person_post" || i.source_type === "li_profile").every((i) => i.lead_id === a1.leadId || i.lead_id === a2.leadId) &&
        companyItems.every((i) => !["li_person_post", "li_profile"].includes(i.source_type)),
      `${itemsA.length} items`,
    );
    assert(
      "batch: every stored item has url, fetched_at, verbatim excerpt, sha256 hash, label observed",
      itemsA.every((i) => /^https?:\/\//.test(i.source_url) && i.fetched_at && i.excerpt.length > 0 && /^[0-9a-f]{64}$/.test(i.content_hash) && i.label === "observed"),
    );
    const reviewItems = itemsA.filter((i) => i.source_type === "google_review");
    assert("batch: place website = company domain → its review kept (1), no reviewer data stored", reviewItems.length === 1 && !JSON.stringify(reviewItems[0]!.raw).match(/reviewer|"name"/));
    const { data: liPayload } = await db.from("enrichment_payloads").select("payload").eq("lead_id", a1.leadId).eq("source", "apify_li_posts").maybeSingle();
    // Same selection as the legacy slot (liPostsForProfile): every post the actor returned whose author is the lead.
    const liPosts = (Array.isArray(liPayload?.payload) ? liPayload.payload : []) as { author?: { linkedinUrl?: string } }[];
    assert(
      "batch: apify_li_posts payload is built from the research run's posts (qualify input unchanged)",
      liPosts.length === 5 && liPosts.every((p) => p.author?.linkedinUrl?.includes(a1.leadSlug)),
      JSON.stringify(liPayload?.payload)?.slice(0, 120),
    );
    assert("batch: both leads → qualifying; research summary on the enrich summary", (await leadState(a1.leadId)) === "qualifying" && (await leadState(a2.leadId)) === "qualifying" && enrichA.research?.runs === 9 && enrichA.research.reused === 5);
    const evA2 = await researchEvent(a2.leadId);
    assert("batch: research_completed event per lead", Boolean(evA2?.sources && evA2.sources.news === "reused" && (await researchEvent(a1.leadId))?.sources?.news === "succeeded"));

    // -----------------------------------------------------------------------
    console.log("\n--- 3. a later contact of the same company within reuse_days ---");
    const a3 = await lead("A", 3);
    const startsBefore = mock.starts.length;
    const later = await runResearchForLeads({ db: wdb, apify, getActiveSetting }, [
      {
        leadId: a3.leadId,
        companyId: a3.companyId,
        leadLinkedinUrl: `https://www.linkedin.com/in/${a3.leadSlug}`,
        company: { name: a3.name, domain: a3.domain, linkedinUrl: `https://www.linkedin.com/company/${a3.companySlug}`, city: "Houston", country: "United States" },
      },
    ]);
    const newStarts = mock.starts.slice(startsBefore);
    assert("later: zero company-level calls; 5 reused rows", newStarts.every((s) => s.source === "li_person_post" || s.source === "li_profile") && later.reused === 5, JSON.stringify(newStarts.map((s) => s.source)));
    const startsBeforeRetry = mock.starts.length;
    const retry = await runResearchForLeads({ db: wdb, apify, getActiveSetting }, [
      {
        leadId: a3.leadId,
        companyId: a3.companyId,
        leadLinkedinUrl: `https://www.linkedin.com/in/${a3.leadSlug}`,
        company: { name: a3.name, domain: a3.domain, linkedinUrl: `https://www.linkedin.com/company/${a3.companySlug}`, city: "Houston", country: "United States" },
      },
    ]);
    assert("later: the same lead again (an enrich retry) → all 7 reused, zero calls", mock.starts.length === startsBeforeRetry && retry.reused === 7 && retry.apify_calls === 0);

    // -----------------------------------------------------------------------
    console.log("\n--- 4. per-lead cost cap ---");
    await company("B");
    const b1 = await lead("B", 1);
    researchPolicy = { ...BASE_POLICY, max_cost_usd_per_lead: 0.02 };
    const capped = await runEnrichStage(enrichDeps(), { leadIds: [b1.leadId] });
    const runsB = await runsFor(b1.companyId);
    assert(
      "cap 0.02: person posts (0.01005) + profile (0.004) run; the 5 company sources are skipped_cap",
      startsFor(b1.companyId).map((s) => s.source).sort().join() === "li_person_post,li_profile" &&
        runsB.filter((r) => r.status === "skipped_cap").map((r) => r.source_type).sort().join() === "blog,google_review,job_post,li_company_post,news",
      JSON.stringify(runsB.map((r) => `${r.source_type}:${r.status}`)),
    );
    assert("cap: skipped rows name the cap and cost 0", runsB.filter((r) => r.status === "skipped_cap").every((r) => /would exceed max_cost_usd_per_lead/.test(r.error ?? "") && Number(r.est_cost_usd) === 0) && capped.research?.skipped_cap === 5);

    // -----------------------------------------------------------------------
    console.log("\n--- 5. failed / empty / refused runs → zero evidence + a note; enrich still completes ---");
    await company("C");
    const c1 = await lead("C", 1);
    researchPolicy = { ...BASE_POLICY, sources: { ...BASE_POLICY.sources, google_review: { enabled: true, max_items: 10, max_charge_usd: 0.01 } } };
    mock.behaviour.set("news", "fail");
    mock.behaviour.set("job_post", "empty");
    mock.behaviour.set("blog", "throw");
    await runEnrichStage(enrichDeps(), { leadIds: [c1.leadId] });
    mock.behaviour.clear();
    const runsC = await runsFor(c1.companyId);
    const statusOf = (s: string) => runsC.find((r) => r.source_type === s);
    const itemsC = await itemsFor(c1.companyId);
    assert("failed run: status failed, error kept, est cost unknown (null)", statusOf("news")?.status === "failed" && /FAILED/.test(statusOf("news")?.error ?? "") && statusOf("news")?.est_cost_usd === null);
    assert("startRun rejected: status failed", statusOf("blog")?.status === "failed" && /402/.test(statusOf("blog")?.error ?? ""));
    assert("empty run: status empty, item_count 0", statusOf("job_post")?.status === "empty" && statusOf("job_post")?.item_count === 0);
    assert("failed/empty sources: zero evidence rows", itemsC.filter((i) => ["news", "blog", "job_post"].includes(i.source_type)).length === 0 && itemsC.length > 0, `${itemsC.length} items from other sources`);
    const evC = await researchEvent(c1.leadId);
    assert(
      "notes: research_failed (news, blog), research_empty (job_post), missing information not evidence",
      Boolean(evC?.notes?.some((n) => /^research_failed: news: .*not evidence/.test(n)) && evC.notes.some((n) => /^research_failed: blog/.test(n)) && evC.notes.some((n) => /^research_empty: job_post/.test(n))),
      JSON.stringify(evC?.notes),
    );
    assert(
      "google_review max_charge_usd 0.01 < the actor's minimalMaxTotalChargeUsd 0.5 → not run, noted",
      startsFor(c1.companyId, "google_review").length === 0 && evC?.sources?.google_review === "max_charge_below_actor_minimum",
    );
    assert("research failures never fail enrich: lead → qualifying", (await leadState(c1.leadId)) === "qualifying");

    // -----------------------------------------------------------------------
    console.log("\n--- 6. a Maps place with another website → zero items + a note ---");
    await company("D");
    const d1 = await lead("D", 1);
    researchPolicy = {
      ...BASE_POLICY,
      sources: Object.fromEntries(Object.entries(BASE_POLICY.sources).map(([k, v]) => [k, { ...v, enabled: k === "google_review" }])) as ResearchPolicy["sources"],
    };
    mock.behaviour.set("google_review", "mismatch");
    await runResearchForLeads({ db: wdb, apify, getActiveSetting }, [
      { leadId: d1.leadId, companyId: d1.companyId, leadLinkedinUrl: null, company: { name: d1.name, domain: d1.domain, linkedinUrl: null, city: "Houston", country: "United States" } },
    ]);
    mock.behaviour.clear();
    const runD = (await runsFor(d1.companyId))[0];
    const evD = await researchEvent(d1.leadId);
    assert(
      "mismatch: run succeeded with 0 items, no evidence, note names the other website",
      runD?.status === "succeeded" && runD.item_count === 0 && (await itemsFor(d1.companyId)).length === 0 && Boolean(evD?.notes?.some((n) => /other-business\.example\.org ≠ company domain/.test(n))),
      JSON.stringify(evD?.notes),
    );

    // -----------------------------------------------------------------------
    console.log("\n--- 7. qualify: research items in the prompt and appended to qualification.evidence ---");
    researchPolicy = BASE_POLICY;
    await runQualifyStage({ db, anthropic, getActiveSetting, transition: state.transition }, { leadIds: [a1.leadId] });
    const prompt = qualifierInputs.at(-1) ?? "";
    assert("qualify: the prompt input has a research array with url/date/excerpt", /"research": \[/.test(prompt) && /"excerpt":/.test(prompt) && /"published_at":/.test(prompt) && prompt.includes("linkedin.com/jobs/view/4400000001"));
    assert("qualify: another contact's person items are not in this lead's input", !prompt.includes(a2.leadSlug));
    const { data: q } = await db.from("qualification").select("evidence").eq("lead_id", a1.leadId).maybeSingle();
    const evidence = (q?.evidence ?? []) as Record<string, unknown>[];
    const appended = evidence.slice(2);
    assert("qualify: the model's 2 items first, then the research items (≤ 8)", evidence.length > 2 && appended.length <= 8 && evidence[0]!.source === "website" && !("evidence_item_id" in evidence[0]!), `${evidence.length} items`);
    assert(
      "qualify: each appended item has url, fetched_at, evidence_item_id, source_type and parses as a stored item",
      appended.every((i) => typeof i.url === "string" && typeof i.fetched_at === "string" && typeof i.evidence_item_id === "string" && typeof i.source_type === "string" && storedEvidenceItemSchema.safeParse(i).success),
    );
    const itemIds = new Set(itemsA.map((i) => i.id));
    assert("qualify: appended observation = the stored verbatim excerpt", appended.every((i) => itemsA.some((row) => row.id === i.evidence_item_id && row.excerpt === i.observation)) && appended.every((i) => itemIds.has(String(i.evidence_item_id))));
    const perSource = new Map<string, number>();
    for (const i of appended) perSource.set(String(i.source_type), (perSource.get(String(i.source_type)) ?? 0) + 1);
    assert("qualify: at most 3 items per source type", [...perSource.values()].every((n) => n <= 3), JSON.stringify([...perSource]));
    assert("qualify: job post and review items carry published_at", appended.filter((i) => i.source_type === "job_post" || i.source_type === "google_review").every((i) => typeof i.published_at === "string"));

    // -----------------------------------------------------------------------
    console.log("\n--- 8. claim guard over the stored research items ---");
    const jobIdx = evidence.findIndex((i) => i.source_type === "job_post");
    const E = `E${jobIdx + 1}`;
    const ctx = await loadClaimContext(db, getActiveSetting, a1.leadId);
    const sentence = `${a1.name} is looking for a Transaction Coordinator to manage contracts and respond to client emails`;
    const draft = (span: string) => ({
      subject: "Transaction Coordinator role",
      body: `Hi Pat,\n\nYour job post says ${span}.\n\n${APPROVED}`,
      claims: [
        { span: "Transaction Coordinator role", kind: "inference", evidence_ids: [E] },
        { span, kind: "prospect_fact", evidence_ids: [E] },
        { span: APPROVED, kind: "offer", evidence_ids: [] },
      ] as Claim[],
    });
    const good = runClaimCheck(ctx, draft(sentence));
    assert(`guard: a claim supported by the job excerpt (${E}) passes`, good.ok, good.ok ? "" : JSON.stringify(good.violations));
    const badSpan = `${a1.name} is looking for a Marketing Director`;
    const bad = runClaimCheck(ctx, draft(badSpan));
    assert("guard: a fact not in the excerpt → unsupported_prospect_fact", !bad.ok && bad.violations.some((v) => v.reason === "unsupported_prospect_fact" && v.token === "Marketing"));
    // Age that one item past the limit while the site crawl stays fresh.
    const aged = evidence.map((i, idx) => (idx === jobIdx ? { ...i, fetched_at: new Date(Date.now() - 31 * DAY).toISOString() } : i));
    await db.from("qualification").update({ evidence: aged as unknown as Json }).eq("lead_id", a1.leadId);
    const staleCtx = await loadClaimContext(db, getActiveSetting, a1.leadId);
    const stale = runClaimCheck(staleCtx, draft(sentence));
    assert(
      "guard: the stale research item → stale_evidence even though the site crawl is fresh",
      !stale.ok && stale.violations.every((v) => v.reason === "stale_evidence") && stale.violations.some((v) => v.evidence_id === E) && staleCtx.evidenceFetchedAt !== null && Date.now() - Date.parse(staleCtx.evidenceFetchedAt) < DAY,
      stale.ok ? "" : JSON.stringify(stale.violations),
    );

    assert("no network calls outside Supabase", network.length === 0, network.join(", "));
  } finally {
    await cleanup();
  }

  const after = await counts();
  console.log(`\nBEFORE ${JSON.stringify(before)}\nAFTER  ${JSON.stringify(after)}`);
  assert("row counts unchanged (scoped cleanup)", JSON.stringify(before) === JSON.stringify(after));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    for (const r of failed) console.error(`- ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error(error);
  try {
    await cleanup();
  } catch (cleanupError) {
    console.error("cleanup failed:", cleanupError);
  }
  process.exit(1);
});
