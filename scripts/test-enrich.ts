import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { ApifyApiError, createApifyClient } from "../src/lib/integrations/apify";
import { createSettingsStore } from "../src/lib/settings/core";
import { createStateStore } from "../src/lib/state/core";
import {
  ENRICHMENT_SOURCE,
  runEnrichStage,
} from "../src/lib/stages/enrich/core";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

if (!process.env.APIFY_TOKEN) {
  console.error("Missing APIFY_TOKEN in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const settings = createSettingsStore(db);
const state = createStateStore(db);
const apify = createApifyClient();

function parseLimit(argv: string[]): number {
  const idx = argv.indexOf("--limit");
  if (idx === -1) {
    return 3;
  }
  const value = Number.parseInt(argv[idx + 1] ?? "3", 10);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

function enrichBatchCap(): number {
  const raw = process.env.ENRICH_BATCH_SIZE ?? "10";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function fetchApifyUsageUsd(): Promise<number | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    return null;
  }
  try {
    const response = await fetch(
      `https://api.apify.com/v2/users/me/usage/monthly?token=${token}`,
    );
    if (!response.ok) {
      return null;
    }
    const json = (await response.json()) as {
      data?: { totalUsageCreditsUsd?: number };
    };
    return json.data?.totalUsageCreditsUsd ?? null;
  } catch {
    return null;
  }
}

function siteTextPreview(payload: unknown): string {
  if (!Array.isArray(payload) || payload.length === 0) {
    return "(no site pages)";
  }
  const first = payload[0] as Record<string, unknown>;
  const text =
    (typeof first.markdown === "string" && first.markdown) ||
    (typeof first.text === "string" && first.text) ||
    "";
  return text.slice(0, 200) || "(empty site text)";
}

function techListPreview(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "(no tech)";
  }
  const names = (payload as { technologyNames?: unknown }).technologyNames;
  if (!Array.isArray(names)) {
    return "(no technologyNames)";
  }
  return names.slice(0, 15).join(", ") || "(empty tech list)";
}

function liPostCount(payload: unknown): number {
  if (Array.isArray(payload)) {
    return payload.length;
  }
  return 0;
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv);
  const batchCap = enrichBatchCap();

  const usageBefore = await fetchApifyUsageUsd();
  if (usageBefore !== null) {
    console.log(`Apify monthly usage before: $${usageBefore.toFixed(4)}`);
  }

  const nowIso = new Date().toISOString();

  const { data: retryLeads } = await db
    .from("leads")
    .select("id")
    .eq("state", "enriching")
    .lte("next_action_at", nowIso)
    .order("next_action_at", { ascending: true })
    .limit(limit);

  const remaining = Math.max(0, limit - (retryLeads?.length ?? 0));
  const { data: sourcedLeads } =
    remaining > 0
      ? await db
          .from("leads")
          .select("id")
          .eq("state", "sourced")
          .order("created_at", { ascending: true })
          .limit(remaining)
      : { data: [] as Array<{ id: string }> };

  const beforeLeads = [...(retryLeads ?? []), ...(sourcedLeads ?? [])];

  const pickedIds = (beforeLeads ?? []).map((l) => l.id);
  if (pickedIds.length === 0) {
    console.error(
      "No leads available to enrich (sourced or enriching due) — run test-source or unpark retries first",
    );
    process.exit(1);
  }

  console.log(
    `Picking up to ${limit} lead(s) to enrich (sourced + enriching due): ${pickedIds.join(", ")}`,
  );

  const summary = await runEnrichStage(
    {
      db,
      apify,
      getActiveSetting: settings.getActiveSetting,
      transition: state.transition,
    },
    { limit },
  );

  console.log("\n=== Enrich summary ===");
  console.log(JSON.stringify(summary, null, 2));

  for (const slot of ["site", "tech", "li_posts"] as const) {
    const run = summary.runs[slot];
    if (!run) {
      console.log(`\n[${slot}] skipped (no URLs)`);
      continue;
    }
    console.log(
      `\n[${slot}] runId=${run.runId} actor=${run.actorId} durationMs=${run.durationMs} items=${run.itemCount} urlsSubmitted=${run.urlsSubmitted}${run.error ? ` error=${run.error}` : ""}`,
    );
  }

  console.log("\n=== Per-lead capture preview ===");
  for (const leadId of pickedIds) {
    const { data: lead } = await db
      .from("leads")
      .select("id, state, first_name, last_name, companies(name, domain)")
      .eq("id", leadId)
      .maybeSingle();

    const { data: payloads } = await db
      .from("enrichment_payloads")
      .select("source, payload")
      .eq("lead_id", leadId)
      .order("fetched_at", { ascending: false });

    const company = lead?.companies as { name: string; domain: string | null } | null;
    const bySource = new Map((payloads ?? []).map((p) => [p.source, p.payload]));

    const site = bySource.get(ENRICHMENT_SOURCE.site);
    const tech = bySource.get(ENRICHMENT_SOURCE.tech);
    const li = bySource.get(ENRICHMENT_SOURCE.li_posts);

    console.log(
      `\n- ${leadId} | ${lead?.first_name ?? ""} ${lead?.last_name ?? ""} | ${company?.name ?? ""} | state=${lead?.state}`,
    );
    console.log(`  site: ${siteTextPreview(site)}`);
    console.log(`  tech: ${techListPreview(tech)}`);
    console.log(`  li_posts: ${liPostCount(li)} posts${isErrorPayload(li) ? ` (${JSON.stringify(li)})` : ""}`);
  }

  const usageAfter = await fetchApifyUsageUsd();
  if (usageAfter !== null && usageBefore !== null) {
    const delta = usageAfter - usageBefore;
    console.log(
      `\nApify monthly usage after: $${usageAfter.toFixed(4)} (delta: $${delta.toFixed(4)})`,
    );
  } else {
    console.log("\nApify cost delta: check Apify console → Usage (usage API unavailable)");
  }

  for (const leadId of pickedIds) {
    const { data: lead } = await db
      .from("leads")
      .select("state")
      .eq("id", leadId)
      .maybeSingle();

    assert(
      `lead ${leadId} in qualifying or parked`,
      lead?.state === "qualifying" || lead?.state === "parked",
      `state=${lead?.state}`,
    );

    const { count: payloadCount } = await db
      .from("enrichment_payloads")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId);

    assert(
      `lead ${leadId} has ≥1 enrichment_payloads row`,
      (payloadCount ?? 0) >= 1,
      `count=${payloadCount}`,
    );

    const { count: eventCount } = await db
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId)
      .in("event", ["enriched", "enrich_failed"]);

    assert(
      `lead ${leadId} has enriched or enrich_failed event`,
      (eventCount ?? 0) >= 1,
      `count=${eventCount}`,
    );
  }

  const { data: allPayloads } = await db
    .from("enrichment_payloads")
    .select("payload")
    .in("lead_id", pickedIds);

  const hasNonempty = (allPayloads ?? []).some((row) => {
    const p = row.payload;
    if (p === null || p === undefined) {
      return false;
    }
    if (typeof p === "object" && !Array.isArray(p) && "error" in p) {
      return false;
    }
    if (Array.isArray(p)) {
      return p.length > 0;
    }
    return Object.keys(p as object).length > 0;
  });

  assert("at least one lead has non-error enrichment payload", hasNonempty);

  for (const slot of ["site", "tech", "li_posts"] as const) {
    const run = summary.runs[slot];
    if (!run) {
      continue;
    }
    assert(
      `${slot} actor submitted ≤ ENRICH_BATCH_SIZE URLs`,
      run.urlsSubmitted <= batchCap,
      `urlsSubmitted=${run.urlsSubmitted} cap=${batchCap}`,
    );
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} assertion(s) failed.`);
    process.exit(1);
  }

  console.log(`\nAll ${results.length} checks passed.`);
}

function isErrorPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    "error" in payload
  );
}

main().catch((error: unknown) => {
  if (error instanceof ApifyApiError) {
    console.error("test-enrich FAILED (Apify):", error.message);
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("test-enrich FAILED:", message);
  process.exit(1);
});
