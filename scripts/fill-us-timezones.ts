import { config } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import { type ApolloOrgEnrichment, createApolloClient } from "../src/lib/integrations/apollo";
import { resolveUsTimezone, type UsTimezoneResult } from "../src/lib/sending/us-timezones";
import type { Json } from "../src/types/database";
import type { DatabaseWithSending } from "../src/types/database-extensions";

// US timezone fill from the company HQ state (operator item, Session 12).
// DRY RUN BY DEFAULT: reads leads + companies, prints what each lead would get.
//
//   pnpm tsx scripts/fill-us-timezones.ts                         dry run, no provider calls
//   pnpm tsx scripts/fill-us-timezones.ts --enrich d1,d2,…        Apollo Organization Enrichment
//                                                                 (1 credit each, max 4), cached
//                                                                 to --cache; still writes no DB rows
//   pnpm tsx scripts/fill-us-timezones.ts --apply                 writes — operator approval first
//   --cache <path>   enrichment cache (default: $TMPDIR/zyndix-apollo-org-enrich.json, never the repo)
//
// State and city come from companies.hq_state/hq_city when set, else from the
// enrichment cache. A missing state or an ambiguous split state resolves to
// nothing: the lead keeps a null timezone and stays held `timezone_unknown`.
// --apply never overwrites an existing leads.timezone and never touches
// leads.state.

const ENRICH_CAP = 4;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const argValue = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const enrichArg = argValue("--enrich");
const cachePath = (() => {
  const raw = argValue("--cache") ?? join(tmpdir(), "zyndix-apollo-org-enrich.json");
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
})();

type CacheEntry = { fetched_at: string; organization: ApolloOrgEnrichment | null };
type Cache = Record<string, CacheEntry>;

function readCache(): Cache {
  if (!existsSync(cachePath)) return {};
  return JSON.parse(readFileSync(cachePath, "utf8")) as Cache;
}

type Row = {
  leadId: string;
  leadState: string;
  leadTimezone: string | null;
  companyId: string;
  company: string;
  domain: string | null;
  state: string | null;
  city: string | null;
  from: "company" | "apollo_cache" | "none";
  result: UsTimezoneResult | null;
  cache: CacheEntry | null;
};

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  const db = createServiceClient(url, key) as unknown as SupabaseClient<DatabaseWithSending>;

  if (cachePath.startsWith(process.cwd())) throw new Error(`--cache must be outside the repo (${cachePath})`);
  console.log(`=== fill-us-timezones (${apply ? "APPLY" : "dry run"}) · cache ${cachePath} ===`);

  // 0009 may not be applied yet: the dry run and --enrich still work without the hq_* columns.
  const withHq = await db
    .from("leads")
    .select("id, state, timezone, company_id, companies(id, name, domain, country, hq_state, hq_city)")
    .order("state");
  const migrated = !withHq.error;
  const { data: leads, error } = migrated
    ? withHq
    : await db.from("leads").select("id, state, timezone, company_id, companies(id, name, domain, country)").order("state");
  if (error) throw new Error(`read leads: ${error.message}`);
  if (!migrated) console.log("note: 0009_send_prereqs.sql not applied — companies.hq_* unavailable, --apply refused");
  if (apply && !migrated) throw new Error("apply 0009_send_prereqs.sql first");

  const cache = readCache();

  if (enrichArg) {
    if (apply) throw new Error("--enrich and --apply are separate steps");
    const domains = [...new Set(enrichArg.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean))];
    if (domains.length > ENRICH_CAP) throw new Error(`--enrich is capped at ${ENRICH_CAP} domains (got ${domains.length})`);
    const known = new Set((leads ?? []).map((l) => (l.companies as { domain: string | null } | null)?.domain?.toLowerCase()));
    for (const d of domains) if (!known.has(d)) throw new Error(`--enrich ${d}: not a company domain of any lead`);
    const apollo = createApolloClient();
    for (const d of domains) {
      if (cache[d]) {
        console.log(`CACHED ${d} (fetched ${cache[d]!.fetched_at}) — no call`);
        continue;
      }
      const organization = await apollo.enrichOrganization(d);
      cache[d] = { fetched_at: new Date().toISOString(), organization };
      writeFileSync(cachePath, JSON.stringify(cache, null, 2));
      console.log(
        `ENRICH ${d} → state=${organization?.state ?? "null"} city=${organization?.city ?? "null"} country=${organization?.country ?? "null"}`,
      );
    }
  }

  const rows: Row[] = (leads ?? []).map((l) => {
    const c = l.companies as {
      id: string;
      name: string;
      domain: string | null;
      hq_state?: string | null;
      hq_city?: string | null;
    } | null;
    const entry = c?.domain ? (cache[c.domain.toLowerCase()] ?? null) : null;
    const fromCompany = Boolean(c?.hq_state);
    const state = fromCompany ? (c!.hq_state ?? null) : (entry?.organization?.state ?? null);
    const city = fromCompany ? (c!.hq_city ?? null) : (entry?.organization?.city ?? null);
    return {
      leadId: l.id,
      leadState: l.state,
      leadTimezone: l.timezone,
      companyId: c?.id ?? "",
      company: c?.name ?? "?",
      domain: c?.domain ?? null,
      state,
      city,
      from: fromCompany ? "company" : entry?.organization ? "apollo_cache" : "none",
      result: l.timezone ? null : resolveUsTimezone({ state, city }),
      cache: entry,
    };
  });

  console.log("");
  console.log(`${"lead_state".padEnd(17)}${"company".padEnd(36)}${"hq_state".padEnd(13)}${"hq_city".padEnd(16)}outcome`);
  for (const r of rows) {
    const outcome = r.leadTimezone
      ? `already set (${r.leadTimezone}) — untouched`
      : r.result!.ok
        ? `${r.result!.timeZone} (${r.result!.source})`
        : `HOLD timezone_unknown — ${r.result!.unresolved}`;
    console.log(
      `${r.leadState.padEnd(17)}${r.company.slice(0, 34).padEnd(36)}${(r.state ?? "-").slice(0, 12).padEnd(13)}${(r.city ?? "-").slice(0, 15).padEnd(16)}${outcome}`,
    );
  }

  const resolved = rows.filter((r) => r.result?.ok);
  const held = rows.filter((r) => r.result && !r.result.ok);
  const reasons: Record<string, number> = {};
  for (const r of held) if (r.result && !r.result.ok) reasons[r.result.unresolved] = (reasons[r.result.unresolved] ?? 0) + 1;
  console.log(
    `\nTOTAL leads=${rows.length} · get a timezone=${resolved.length} · stay held=${held.length} ${JSON.stringify(reasons)} · already set=${rows.filter((r) => r.leadTimezone).length}`,
  );

  if (!apply) {
    console.log("\nDry run: nothing written to the DB. Re-run with --apply after operator approval.");
    return;
  }

  for (const r of resolved) {
    if (!r.result?.ok) continue;
    const now = new Date().toISOString();
    if (r.from === "apollo_cache" && r.cache?.organization) {
      const org = r.cache.organization;
      const { error: cErr } = await db
        .from("companies")
        .update({
          hq_state: org.state ?? null,
          hq_city: org.city ?? null,
          hq_location_source: "apollo_org_enrich",
          hq_location_fetched_at: r.cache.fetched_at,
        })
        .eq("id", r.companyId)
        .is("hq_state", null);
      if (cErr) throw new Error(`update company ${r.companyId}: ${cErr.message}`);
      const { error: eErr } = await db.from("enrichment_payloads").insert({
        company_id: r.companyId,
        source: "apollo_org_enrich",
        payload: org as unknown as Json,
        fetched_at: r.cache.fetched_at,
      });
      if (eErr) throw new Error(`insert enrichment_payloads ${r.companyId}: ${eErr.message}`);
      console.log(`WROTE  companies ${r.company}: hq_state=${org.state} hq_city=${org.city ?? "null"} + enrichment_payloads`);
    }
    const { data: updated, error: lErr } = await db
      .from("leads")
      .update({ timezone: r.result.timeZone, timezone_source: r.result.source, timezone_derived_at: now })
      .eq("id", r.leadId)
      .is("timezone", null)
      .select("id");
    if (lErr) throw new Error(`update lead ${r.leadId}: ${lErr.message}`);
    if (!updated?.length) {
      console.log(`SKIP   lead ${r.leadId}: timezone set concurrently`);
      continue;
    }
    const { error: evErr } = await db.from("lead_events").insert({
      lead_id: r.leadId,
      event: "timezone_derived",
      detail: {
        time_zone: r.result.timeZone,
        source: r.result.source,
        hq_state: r.state,
        hq_city: r.city,
        location_from: r.from === "company" ? "companies.hq_state" : "apollo_org_enrich",
      } as Json,
    });
    if (evErr) throw new Error(`lead_event ${r.leadId}: ${evErr.message}`);
    console.log(`WROTE  lead ${r.company}: timezone=${r.result.timeZone} (${r.result.source})`);
  }
}

main().catch((error: unknown) => {
  console.error("fill-us-timezones FAILED:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
