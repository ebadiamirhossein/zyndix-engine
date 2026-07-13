import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createAnthropicClient } from "../src/lib/integrations/anthropic";
import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";
import { createStateStore } from "../src/lib/state/core";
import { runQualifyStage } from "../src/lib/stages/qualify/core";
import { qualifierOutputSchema } from "../src/lib/validation/llm";
import { __testOnly_selectMostRecentNonErrorPayloadsBySource } from "../src/lib/stages/qualify/core";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const settings = createSettingsStore(db);
const state = createStateStore(db);
const anthropic = createAnthropicClient();

function parseLimit(argv: string[]): number {
  const idx = argv.indexOf("--limit");
  if (idx === -1) {
    return 3;
  }
  const value = Number.parseInt(argv[idx + 1] ?? "3", 10);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

type EvidenceItem = { source: string; observation: string };

function formatLeadHeader(row: {
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  companies: { name: string; domain: string | null } | null;
}): string {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || "(no name)";
  const title = row.title ?? "(no title)";
  const company = row.companies?.name ?? "(no company)";
  const domain = row.companies?.domain ?? "(no domain)";
  return `── ${name} | ${title} | ${company} (${domain})`;
}

function printQualification(row: {
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  companies: { name: string; domain: string | null } | null;
  qualification: {
    fit_score: number | null;
    segment: string | null;
    problem_hypothesis: string;
    evidence: unknown;
    visible_tools: unknown;
    triggers: unknown;
    recommended_angle: string | null;
    disqualify_reason: string | null;
    prompt_version: number | null;
    model: string | null;
  } | null;
}): void {
  console.log(formatLeadHeader(row));
  const q = row.qualification;
  if (!q) {
    console.log("   (no qualification row)");
    return;
  }

  console.log(
    `   fit_score: ${q.fit_score ?? "null"}   segment: ${q.segment ?? "null"}   angle: ${q.recommended_angle ?? "null"}`,
  );
  console.log(`   hypothesis: ${q.problem_hypothesis}`);
  console.log("   evidence:");
  const evidence = Array.isArray(q.evidence) ? (q.evidence as EvidenceItem[]) : [];
  if (evidence.length === 0) {
    console.log("     (none)");
  } else {
    for (const item of evidence) {
      console.log(`     - [${item.source}] "${item.observation}"`);
    }
  }
  console.log(`   visible_tools: ${JSON.stringify(q.visible_tools ?? [])}`);
  console.log(`   triggers: ${JSON.stringify(q.triggers ?? [])}`);
  console.log(`   disqualify_reason: ${q.disqualify_reason ?? "null"}`);
  console.log(`   prompt_version: ${q.prompt_version ?? "null"}   model: ${q.model ?? "null"}`);
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));
  console.log(`\n=== test-qualify (limit=${limit}) ===\n`);

  // Regression guard: an error payload must not shadow a prior successful payload.
  const TEST_SENTINEL = "SENTINEL_SITE_TEXT_SHOULD_BE_SELECTED";
  let testCompanyId: string | null = null;
  let testLeadId: string | null = null;
  try {
    const { data: company, error: companyError } = await db
      .from("companies")
      .insert({ name: "Qualify Shadow Test Co", domain: `shadow-test-${Date.now()}.example.com` })
      .select("id")
      .single();
    if (companyError || !company) {
      throw new Error(`Failed to create shadow test company: ${companyError?.message}`);
    }
    testCompanyId = company.id;

    const { data: lead, error: leadError } = await db
      .from("leads")
      .insert({
        company_id: company.id,
        first_name: "Shadow",
        last_name: "Test",
        email: `shadow@test-${Date.now()}.example.com`,
        state: "qualifying",
      })
      .select("id")
      .single();
    if (leadError || !lead) {
      throw new Error(`Failed to create shadow test lead: ${leadError?.message}`);
    }
    testLeadId = lead.id;

    const goodSitePayload = [
      {
        url: "https://example.com/",
        markdown: `# Home\n\n${TEST_SENTINEL}\n`,
      },
    ];

    const { error: payloadInsert1 } = await db.from("enrichment_payloads").insert([
      {
        lead_id: testLeadId,
        company_id: testCompanyId,
        source: "apify_site",
        payload: goodSitePayload as any,
        fetched_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        lead_id: testLeadId,
        company_id: testCompanyId,
        source: "apify_tech",
        payload: { technologyNames: ["Bootstrap"] } as any,
        fetched_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        lead_id: testLeadId,
        company_id: testCompanyId,
        source: "apify_li_posts",
        payload: { error: "no_linkedin_url" } as any,
        fetched_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);
    if (payloadInsert1) {
      throw new Error(`Failed to insert initial enrichment payloads: ${payloadInsert1.message}`);
    }

    // Insert a newer error row for apify_site that must NOT shadow the good one.
    const { error: payloadInsert2 } = await db.from("enrichment_payloads").insert({
      lead_id: testLeadId,
      company_id: testCompanyId,
      source: "apify_site",
      payload: { error: "no_site_pages_returned" } as any,
      fetched_at: new Date().toISOString(),
    });
    if (payloadInsert2) {
      throw new Error(`Failed to insert shadowing error payload: ${payloadInsert2.message}`);
    }

    const { data: payloadRows } = await db
      .from("enrichment_payloads")
      .select("source, payload")
      .eq("lead_id", testLeadId)
      .order("fetched_at", { ascending: false });

    const grouped = __testOnly_selectMostRecentNonErrorPayloadsBySource(
      (payloadRows ?? []).map((row) => ({
        source: row.source,
        payload: row.payload as any,
      })),
    );

    const selectedSite = JSON.stringify(grouped["apify_site"] ?? null);
    assert(
      "select most recent NON-ERROR payload per source (error does not shadow success)",
      selectedSite.includes(TEST_SENTINEL),
    );
  } finally {
    if (testLeadId) {
      await db.from("enrichment_payloads").delete().eq("lead_id", testLeadId);
      await db.from("lead_events").delete().eq("lead_id", testLeadId);
      await db.from("qualification_history").delete().eq("lead_id", testLeadId);
      await db.from("qualification").delete().eq("lead_id", testLeadId);
      await db.from("leads").delete().eq("id", testLeadId);
    }
    if (testCompanyId) {
      await db.from("companies").delete().eq("id", testCompanyId);
    }
  }

  const pickedBefore = await db
    .from("leads")
    .select("id")
    .eq("state", "qualifying")
    .order("created_at", { ascending: true })
    .limit(limit);

  const pickedIds = (pickedBefore.data ?? []).map((row) => row.id);
  console.log(`Picking up to ${limit} leads in qualifying (${pickedIds.length} available)\n`);

  const summary = await runQualifyStage(
    {
      db,
      anthropic,
      getActiveSetting: settings.getActiveSetting,
      transition: state.transition,
    },
    { limit },
  );

  console.log("\n--- Stage summary ---");
  console.log(JSON.stringify(summary, null, 2));

  const costPerLead =
    summary.leads_picked > 0 ? summary.est_cost_usd / summary.leads_picked : 0;
  console.log(
    `\nTokens: ${summary.tokens_used} total | Est. cost: $${summary.est_cost_usd.toFixed(4)} total | $${costPerLead.toFixed(4)}/lead`,
  );

  console.log("\n--- Qualifications ---\n");

  const processedLeads = await db
    .from("leads")
    .select("id, state, first_name, last_name, title, companies(name, domain)")
    .in("id", pickedIds.length > 0 ? pickedIds : ["00000000-0000-0000-0000-000000000000"]);

  const leadRows = processedLeads.data ?? [];

  const { data: qualificationRows } = await db
    .from("qualification")
    .select(
      "lead_id, fit_score, segment, problem_hypothesis, evidence, visible_tools, triggers, recommended_angle, disqualify_reason, prompt_version, model",
    )
    .in("lead_id", pickedIds.length > 0 ? pickedIds : ["00000000-0000-0000-0000-000000000000"]);

  const qualificationByLead = new Map(
    (qualificationRows ?? []).map((row) => [row.lead_id, row]),
  );

  for (const row of leadRows) {
    printQualification({
      first_name: row.first_name,
      last_name: row.last_name,
      title: row.title,
      companies: row.companies as { name: string; domain: string | null } | null,
      qualification: qualificationByLead.get(row.id) ?? null,
    });
    console.log("");
  }

  console.log("--- Assertions ---\n");

  for (const id of pickedIds) {
    const lead = leadRows.find((row) => row.id === id);
    assert(
      `lead ${id.slice(0, 8)} not left in qualifying`,
      lead?.state !== "qualifying",
      `state=${lead?.state ?? "missing"}`,
    );
  }

  const qualifiedLeads = leadRows.filter((row) => row.state === "qualified");
  for (const lead of qualifiedLeads) {
    const q = qualificationByLead.get(lead.id);

    const evidence = Array.isArray(q?.evidence) ? (q.evidence as EvidenceItem[]) : [];

    assert(
      `qualified ${lead.id.slice(0, 8)} has non-empty problem_hypothesis`,
      Boolean(q?.problem_hypothesis?.trim()),
    );
    assert(
      `qualified ${lead.id.slice(0, 8)} evidence.length >= 1`,
      evidence.length >= 1,
      `got ${evidence.length}`,
    );
    assert(
      `qualified ${lead.id.slice(0, 8)} evidence observations non-empty`,
      evidence.every((item) => item.observation.trim().length > 0),
    );

    const { count: historyCount, error: historyError } = await db
      .from("qualification_history")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", lead.id);

    assert(
      `qualified ${lead.id.slice(0, 8)} has qualification_history row`,
      !historyError && (historyCount ?? 0) >= 1,
      historyError?.message,
    );

    assert(
      `qualified ${lead.id.slice(0, 8)} records prompt_version`,
      q?.prompt_version != null && q.prompt_version > 0,
    );
    assert(
      `qualified ${lead.id.slice(0, 8)} records model`,
      Boolean(q?.model?.trim()),
    );
  }

  const sampleQualification =
    qualifiedLeads.length > 0
      ? qualificationByLead.get(qualifiedLeads[0]!.id)
      : (qualificationRows ?? []).find((row) => pickedIds.includes(row.lead_id)) ??
        (await db
          .from("qualification")
          .select(
            "lead_id, fit_score, segment, problem_hypothesis, evidence, visible_tools, triggers, recommended_angle, disqualify_reason, prompt_version, model",
          )
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()).data;

  if (sampleQualification) {
    const q = sampleQualification;

    const blanked = {
      fit_score: q.fit_score ?? 70,
      segment: q.segment ?? "us-realestate",
      problem_hypothesis: q.problem_hypothesis,
      evidence: [],
      triggers: q.triggers ?? [],
      visible_tools: q.visible_tools ?? [],
      recommended_angle: q.recommended_angle ?? "speed-to-lead",
      disqualify_reason: null,
    };

    const rejected = !qualifierOutputSchema.safeParse(blanked).success;
    assert("negative test: blank evidence rejected by qualifierOutputSchema", rejected);
  } else {
    assert(
      "negative test: blank evidence rejected by qualifierOutputSchema",
      false,
      "no qualification row to test",
    );
  }

  const passCount = results.filter((result) => result.pass).length;
  const failCount = results.length - passCount;
  console.log(`\n=== ${passCount}/${results.length} PASS, ${failCount} FAIL ===\n`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
