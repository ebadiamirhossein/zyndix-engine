import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApifyClient, ApifyRunWithItems } from "@/lib/integrations/apify";
import { createStateStore } from "@/lib/state/core";
import type { ApifyActorTemplates } from "@/lib/validation/jsonb";
import type { Database, Json } from "@/types/database";

export const ENRICHMENT_SOURCE = {
  site: "apify_site",
  tech: "apify_tech",
  li_posts: "apify_li_posts",
} as const;

export type EnrichStageSummary = {
  leads_picked: number;
  runs: {
    site: RunSummary | null;
    tech: RunSummary | null;
    li_posts: RunSummary | null;
  };
  payloads_written: number;
  sources_failed: number;
  leads_to_qualifying: number;
  leads_parked: number;
};

type RunSummary = {
  runId: string;
  actorId: string;
  durationMs: number;
  itemCount: number;
  urlsSubmitted: number;
  error?: string;
};

type LeadPick = {
  id: string;
  company_id: string;
  linkedin_url: string | null;
  domain: string;
};

type EnrichDeps = {
  db: SupabaseClient<Database>;
  apify: ApifyClient;
  getActiveSetting: (key: string) => Promise<{ value: unknown }>;
  transition: ReturnType<typeof createStateStore>["transition"];
};

type ActorSlot = "site" | "tech" | "li_posts";

type ActorOutcome =
  | { ok: true; run: ApifyRunWithItems; urlsSubmitted: number }
  | { ok: false; error: string; urlsSubmitted: number };

function enrichBatchSize(): number {
  const raw = process.env.ENRICH_BATCH_SIZE ?? "10";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function assertBatchCap(urlCount: number, label: string): void {
  const cap = enrichBatchSize();
  if (urlCount > cap) {
    throw new Error(
      `ENRICH_BATCH_SIZE cap exceeded for ${label}: ${urlCount} URLs (max ${cap})`,
    );
  }
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function urlMatchesDomain(url: string, domain: string): boolean {
  const host = hostnameFromUrl(url);
  const d = domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

function normalizeLinkedInUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.origin}${u.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/$/, "");
  }
}

function linkedInUrlsMatch(a: string, b: string): boolean {
  const na = normalizeLinkedInUrl(a);
  const nb = normalizeLinkedInUrl(b);
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

function itemUrl(item: Record<string, unknown>): string | null {
  if (typeof item.url === "string") {
    return item.url;
  }
  return null;
}

function itemLinkedInProfileUrl(item: Record<string, unknown>): string | null {
  const author = item.author;
  if (typeof author === "object" && author !== null && "linkedinUrl" in author) {
    const url = (author as { linkedinUrl: unknown }).linkedinUrl;
    if (typeof url === "string") {
      return url;
    }
  }
  if (typeof item.linkedinUrl === "string") {
    return item.linkedinUrl;
  }
  return null;
}

function sitePayloadForDomain(
  items: Record<string, unknown>[],
  domain: string,
): unknown {
  const pages = items.filter((item) => {
    const url = itemUrl(item);
    return url ? urlMatchesDomain(url, domain) : false;
  });
  if (pages.length === 0) {
    return { error: "no_site_pages_returned" };
  }
  return pages;
}

function techPayloadForDomain(
  items: Record<string, unknown>[],
  domain: string,
): unknown {
  const row = items.find((item) => {
    const url = itemUrl(item);
    return url ? urlMatchesDomain(url, domain) : false;
  });
  if (!row) {
    return { error: "no_tech_result" };
  }
  return row;
}

function liPostsForProfile(
  items: Record<string, unknown>[],
  profileUrl: string,
  batchProfileUrls: string[],
): unknown {
  const posts = items.filter((item) => {
    const itemProfile = itemLinkedInProfileUrl(item);
    return itemProfile ? linkedInUrlsMatch(itemProfile, profileUrl) : false;
  });
  if (posts.length > 0) {
    return posts;
  }

  const batchSingle =
    batchProfileUrls.length === 1 &&
    linkedInUrlsMatch(batchProfileUrls[0]!, profileUrl);

  if (batchSingle && items.length > 0) {
    return items;
  }

  return { error: "no_linkedin_posts" };
}

function isErrorPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "string"
  );
}

function buildSiteInput(template: ApifyActorTemplates["site"], domains: string[]) {
  return {
    ...template.input,
    startUrls: domains.map((domain) => ({ url: `https://${domain}` })),
  };
}

function buildTechInput(template: ApifyActorTemplates["tech"], domains: string[]) {
  return {
    ...template.input,
    urls: domains.map((domain) => `https://${domain}`),
  };
}

function buildLiInput(
  template: ApifyActorTemplates["li_posts"],
  profileUrls: string[],
) {
  return {
    ...template.input,
    targetUrls: profileUrls,
  };
}

async function countEnrichFailures(
  db: SupabaseClient<Database>,
  leadId: string,
): Promise<number> {
  const { count, error } = await db
    .from("lead_events")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("event", "enrich_failed");

  if (error) {
    throw new Error(`Failed to count enrich_failed for ${leadId}: ${error.message}`);
  }
  return count ?? 0;
}

async function insertPayload(
  db: SupabaseClient<Database>,
  row: {
    company_id: string;
    lead_id: string;
    source: string;
    payload: unknown;
  },
): Promise<void> {
  const { error } = await db.from("enrichment_payloads").insert({
    company_id: row.company_id,
    lead_id: row.lead_id,
    source: row.source,
    payload: row.payload as Json,
    fetched_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to insert enrichment_payloads: ${error.message}`);
  }
}

function runSummaryFromOutcome(
  slot: ActorSlot,
  templates: ApifyActorTemplates,
  outcome: ActorOutcome,
): RunSummary | null {
  if (outcome.urlsSubmitted === 0) {
    return null;
  }

  const actorId = templates[slot].actor_id;

  if (!outcome.ok) {
    return {
      runId: "n/a",
      actorId,
      durationMs: 0,
      itemCount: 0,
      urlsSubmitted: outcome.urlsSubmitted,
      error: outcome.error,
    };
  }

  return {
    runId: outcome.run.runId,
    actorId: outcome.run.actorId,
    durationMs: outcome.run.durationMs,
    itemCount: outcome.run.itemCount,
    urlsSubmitted: outcome.urlsSubmitted,
  };
}

export async function runEnrichStage(
  deps: EnrichDeps,
  options?: {
    limit?: number;
  /** Only these leads (scripts and tests; production passes nothing and picks by state). */
  leadIds?: string[];
  },
): Promise<EnrichStageSummary> {
  const batchCap = options?.limit ?? enrichBatchSize();
  const summary: EnrichStageSummary = {
    leads_picked: 0,
    runs: { site: null, tech: null, li_posts: null },
    payloads_written: 0,
    sources_failed: 0,
    leads_to_qualifying: 0,
    leads_parked: 0,
  };

  const templatesSetting = await deps.getActiveSetting("apify_actor_templates");
  const templates = templatesSetting.value as ApifyActorTemplates;

  const nowIso = new Date().toISOString();

  // Prefer retries first (enriching + due), then fill with sourced.
  let retryQuery = deps.db
    .from("leads")
    .select("id, linkedin_url, company_id, companies!inner(domain)")
    .eq("state", "enriching")
    .lte("next_action_at", nowIso);
  if (options?.leadIds) retryQuery = retryQuery.in("id", options.leadIds);
  const { data: retryRows, error: retryError } = await retryQuery
    .order("next_action_at", { ascending: true })
    .limit(batchCap);

  if (retryError) {
    throw new Error(`Failed to pick enriching retry leads: ${retryError.message}`);
  }

  const remaining = Math.max(0, batchCap - (retryRows?.length ?? 0));
  let sourcedQuery = deps.db
    .from("leads")
    .select("id, linkedin_url, company_id, companies!inner(domain)")
    .eq("state", "sourced");
  if (options?.leadIds) sourcedQuery = sourcedQuery.in("id", options.leadIds);
  const { data: sourcedRows, error: sourcedError } =
    remaining > 0
      ? await sourcedQuery
          .order("created_at", { ascending: true })
          .limit(remaining)
      : { data: [], error: null };

  if (sourcedError) {
    throw new Error(`Failed to pick sourced leads: ${sourcedError.message}`);
  }

  const rows = [...(retryRows ?? []), ...(sourcedRows ?? [])];

  const leads: LeadPick[] = rows.map((row) => {
    const company = row.companies as { domain: string | null };
    if (!company?.domain) {
      throw new Error(`Lead ${row.id} company has no domain`);
    }
    return {
      id: row.id,
      company_id: row.company_id!,
      linkedin_url: row.linkedin_url,
      domain: company.domain,
    };
  });

  summary.leads_picked = leads.length;
  if (leads.length === 0) {
    console.log("[enrich] no leads to enrich");
    return summary;
  }

  for (const lead of leads) {
    const { data: current, error: stateError } = await deps.db
      .from("leads")
      .select("state")
      .eq("id", lead.id)
      .maybeSingle();

    if (stateError || !current?.state) {
      throw new Error(
        `Failed to load lead state for ${lead.id}: ${stateError?.message ?? "missing row"}`,
      );
    }

    if (current.state === "sourced") {
      await deps.transition(lead.id, "sourced", "enriching", "enrich_started", {
        domain: lead.domain,
      });
    } else {
      await deps.db.from("lead_events").insert({
        lead_id: lead.id,
        event: "enrich_retry_started",
        detail: { domain: lead.domain },
      });
    }
  }

  const domains = [...new Set(leads.map((l) => l.domain))];
  const linkedinLeads = leads.filter((l) => l.linkedin_url);
  const linkedinUrls = [
    ...new Set(
      linkedinLeads
        .map((l) => l.linkedin_url)
        .filter((url): url is string => Boolean(url)),
    ),
  ];

  assertBatchCap(domains.length, "site+tech");
  assertBatchCap(linkedinUrls.length, "li_posts");

  const [siteOutcome, techOutcome, liOutcome] = await Promise.all([
    runActorSlot(deps.apify, templates.site, buildSiteInput(templates.site, domains), domains.length),
    runActorSlot(deps.apify, templates.tech, buildTechInput(templates.tech, domains), domains.length),
    linkedinUrls.length > 0
      ? runActorSlot(
          deps.apify,
          templates.li_posts,
          buildLiInput(templates.li_posts, linkedinUrls),
          linkedinUrls.length,
        )
      : Promise.resolve({ ok: false, error: "no_linkedin_urls_in_batch", urlsSubmitted: 0 } satisfies ActorOutcome),
  ]);

  summary.runs.site = runSummaryFromOutcome("site", templates, siteOutcome);
  summary.runs.tech = runSummaryFromOutcome("tech", templates, techOutcome);
  summary.runs.li_posts = runSummaryFromOutcome("li_posts", templates, liOutcome);

  const siteItems = siteOutcome.ok ? siteOutcome.run.items : [];
  const techItems = techOutcome.ok ? techOutcome.run.items : [];
  const liItems = liOutcome.ok ? liOutcome.run.items : [];

  for (const lead of leads) {
    try {
      const sourcesOk: string[] = [];
      const sourcesFailed: string[] = [];

      const sitePayload = siteOutcome.ok
        ? sitePayloadForDomain(siteItems, lead.domain)
        : { error: siteOutcome.error };
      await insertPayload(deps.db, {
        company_id: lead.company_id,
        lead_id: lead.id,
        source: ENRICHMENT_SOURCE.site,
        payload: sitePayload,
      });
      summary.payloads_written += 1;
      if (isErrorPayload(sitePayload)) {
        sourcesFailed.push(ENRICHMENT_SOURCE.site);
        summary.sources_failed += 1;
      } else {
        sourcesOk.push(ENRICHMENT_SOURCE.site);
      }

      const techPayload = techOutcome.ok
        ? techPayloadForDomain(techItems, lead.domain)
        : { error: techOutcome.error };
      await insertPayload(deps.db, {
        company_id: lead.company_id,
        lead_id: lead.id,
        source: ENRICHMENT_SOURCE.tech,
        payload: techPayload,
      });
      summary.payloads_written += 1;
      if (isErrorPayload(techPayload)) {
        sourcesFailed.push(ENRICHMENT_SOURCE.tech);
        summary.sources_failed += 1;
      } else {
        sourcesOk.push(ENRICHMENT_SOURCE.tech);
      }

      let liPayload: unknown;
      if (!lead.linkedin_url) {
        liPayload = { error: "no_linkedin_url" };
      } else if (liOutcome.ok) {
        liPayload = liPostsForProfile(liItems, lead.linkedin_url, linkedinUrls);
      } else {
        liPayload = { error: liOutcome.error };
      }

      await insertPayload(deps.db, {
        company_id: lead.company_id,
        lead_id: lead.id,
        source: ENRICHMENT_SOURCE.li_posts,
        payload: liPayload,
      });
      summary.payloads_written += 1;
      if (isErrorPayload(liPayload)) {
        sourcesFailed.push(ENRICHMENT_SOURCE.li_posts);
        summary.sources_failed += 1;
      } else {
        sourcesOk.push(ENRICHMENT_SOURCE.li_posts);
      }

      await deps.transition(lead.id, "enriching", "qualifying", "enriched", {
        sources_ok: sourcesOk,
        sources_failed: sourcesFailed,
      });
      summary.leads_to_qualifying += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const priorFailures = await countEnrichFailures(deps.db, lead.id);
      const attempt = priorFailures + 1;

      await deps.db.from("lead_events").insert({
        lead_id: lead.id,
        event: "enrich_failed",
        detail: { error: message, attempt },
      });

      if (attempt >= 3) {
        await deps.db
          .from("companies")
          .update({ park_reason: "enrichment_failed_3x", status: "parked" })
          .eq("id", lead.company_id);

        await deps.transition(lead.id, "enriching", "parked", "enrich_failed", {
          park_reason: "enrichment_failed_3x",
          error: message,
          attempt,
        });
        summary.leads_parked += 1;
        console.log(`[enrich] lead ${lead.id} parked after 3 enrichment failures`);
      } else {
        const retryAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const { error: retryError } = await deps.db
          .from("leads")
          .update({ next_action_at: retryAt })
          .eq("id", lead.id);

        if (retryError) {
          throw new Error(`Failed to schedule enrich retry for ${lead.id}: ${retryError.message}`);
        }
        console.log(
          `[enrich] lead ${lead.id} enrich_failed attempt ${attempt}/3, retry at ${retryAt}`,
        );
      }
    }
  }

  return summary;
}

async function runActorSlot(
  apify: ApifyClient,
  template: ApifyActorTemplates[ActorSlot],
  input: Record<string, unknown>,
  urlsSubmitted: number,
): Promise<ActorOutcome> {
  if (urlsSubmitted === 0) {
    return { ok: false, error: "skipped_empty_batch", urlsSubmitted: 0 };
  }

  try {
    const run =
      template.actor_id === "apify/tech-stack-detector"
        ? await apify.runAndWaitWith429Backoff(template.actor_id, input, {
            label: "tech-stack",
            urlsField: "urls",
            shrinkTo: Math.max(1, Math.min(2, urlsSubmitted)),
            waitMs: 60_000,
          })
        : await apify.runAndWait(template.actor_id, input);
    return { ok: true, run, urlsSubmitted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[enrich] actor ${template.actor_id} failed: ${message}`);
    return { ok: false, error: message, urlsSubmitted };
  }
}
