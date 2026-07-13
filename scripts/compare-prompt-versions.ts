import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createAnthropicClient, parseJsonText } from "../src/lib/integrations/anthropic";
import { createSettingsStore } from "../src/lib/settings/core";
import { parseOrThrow } from "../src/lib/validation";
import { qualifierOutputSchema } from "../src/lib/validation/llm";

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
const anthropic = createAnthropicClient();

const LEADS = [
  { idPrefix: "5976b68f", label: "REBGroup" },
  { idPrefix: "041142cc", label: "Gottesman" },
  { idPrefix: "0f20b919", label: "Steffen" },
  { idPrefix: "b48ad46e", label: "Stride" },
] as const;

function qualifyMinScore(): number {
  const raw = process.env.QUALIFY_MIN_SCORE ?? "50";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 50;
}

function verdictFrom(output: {
  fit_score: number;
  disqualify_reason: string | null;
}): "qualified" | "parked" {
  if (output.disqualify_reason) return "parked";
  return output.fit_score >= qualifyMinScore() ? "qualified" : "parked";
}

function payloadIsErrorRow(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "string"
  );
}

function selectMostRecentNonErrorBySource(
  rows: Array<{ source: string | null; payload: unknown }>,
): Map<string, unknown> {
  // rows should be ordered fetched_at DESC (newest first)
  const picked = new Map<string, unknown>();
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row.source) continue;
    if (seen.has(row.source)) continue;
    if (!payloadIsErrorRow(row.payload)) {
      picked.set(row.source, row.payload);
      seen.add(row.source);
    }
  }

  for (const row of rows) {
    if (!row.source) continue;
    if (picked.has(row.source)) continue;
    picked.set(row.source, row.payload);
  }

  return picked;
}

function extractSiteText(payload: unknown): string {
  if (!Array.isArray(payload)) return "";
  const parts: string[] = [];
  for (const page of payload) {
    if (typeof page !== "object" || page === null) continue;
    const record = page as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : "unknown";
    const text =
      (typeof record.markdown === "string" && record.markdown) ||
      (typeof record.text === "string" && record.text) ||
      "";
    if (text) parts.push(`--- ${url} ---\n${text}`);
  }
  return parts.join("\n\n");
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

async function resolveLeadId(prefix: string): Promise<string> {
  const { data, error } = await db.from("leads").select("id");
  if (error) throw new Error(`Failed to list lead ids: ${error.message}`);
  const match = (data ?? []).find((row) => row.id.startsWith(prefix));
  if (!match) {
    throw new Error(`Lead id not found for prefix ${prefix}`);
  }
  return match.id;
}

async function buildSystemPromptForQualifierVersion(version: number): Promise<string> {
  const { data: rows, error } = await db
    .from("settings")
    .select("value")
    .eq("key", "qualifier_prompt")
    .eq("version", version)
    .limit(1);

  if (error) throw new Error(`Failed to load qualifier_prompt v${version}: ${error.message}`);
  const promptTemplate = String(rows?.[0]?.value ?? "");
  if (!promptTemplate) throw new Error(`Missing qualifier_prompt v${version}`);

  const [icp, seg] = await Promise.all([
    settings.getActiveSetting("icp_rubric"),
    settings.getActiveSetting("segments"),
  ]);

  return promptTemplate
    .replace("{{icp_rubric}}", String(icp.value))
    .replace("{{segments}}", JSON.stringify(seg.value, null, 2));
}

async function rerunLead(leadId: string, systemPrompt: string) {
  const { data: lead, error: leadError } = await db
    .from("leads")
    .select(
      "id, first_name, last_name, title, companies!inner(name, domain, industry, employee_range, country, city)",
    )
    .eq("id", leadId)
    .single();

  if (leadError || !lead) throw new Error(`Failed to load lead ${leadId}: ${leadError?.message}`);

  const { data: payloadRows, error: payloadError } = await db
    .from("enrichment_payloads")
    .select("source, payload, fetched_at")
    .eq("lead_id", leadId)
    .order("fetched_at", { ascending: false });

  if (payloadError) {
    throw new Error(`Failed to load enrichment_payloads for ${leadId}: ${payloadError.message}`);
  }

  const bySource = selectMostRecentNonErrorBySource(
    (payloadRows ?? []).map((r) => ({ source: r.source, payload: r.payload })),
  );
  const sitePayload = bySource.get("apify_site");
  const techPayload = bySource.get("apify_tech");
  const liPayload = bySource.get("apify_li_posts");

  const maxSiteChars =
    Number.parseInt(process.env.QUALIFY_MAX_SITE_CHARS ?? "20000", 10) || 20000;
  const crawlText = truncate(extractSiteText(sitePayload), maxSiteChars);

  const userInput = {
    apollo: {
      first_name: lead.first_name,
      last_name: lead.last_name,
      title: lead.title,
      company_name: (lead.companies as any).name,
      domain: (lead.companies as any).domain,
      industry: (lead.companies as any).industry,
      employee_range: (lead.companies as any).employee_range,
      country: (lead.companies as any).country,
      city: (lead.companies as any).city,
    },
    website: {
      crawl: crawlText || sitePayload || null,
      tech_stack: payloadIsErrorRow(techPayload)
        ? {
            status:
              "UNAVAILABLE — we failed to fetch this. You know NOTHING about their tech stack. Do not infer absence of tools.",
          }
        : (techPayload ?? null),
    },
    linkedin: liPayload ?? null,
  };

  const completion = await anthropic.complete({
    system: systemPrompt,
    user: JSON.stringify(userInput, null, 2),
    temperature: 0.1,
    maxTokens: 4096,
  });

  const parsed = parseOrThrow(
    qualifierOutputSchema,
    parseJsonText(completion.text),
    `compare-prompt-versions:${leadId}`,
  );

  return { lead, parsed, completion };
}

async function main(): Promise<void> {
  // old = current stored qualification, new = rerun with qualifier_prompt v4
  const systemV4 = await buildSystemPromptForQualifierVersion(4);

  const rows: Array<{
    leadName: string;
    leadId: string;
    oldScore: number | null;
    newScore: number;
    oldVerdict: string;
    newVerdict: string;
    oldHypothesis: string | null;
    newHypothesis: string | null;
    oldDisqualify: string | null;
    newDisqualify: string | null;
  }> = [];

  const changed: Array<{
    leadName: string;
    leadId: string;
    oldVerdict: string;
    newVerdict: string;
    newHypothesis: string | null;
    newEvidence: unknown;
    newDisqualify: string | null;
  }> = [];

  for (const item of LEADS) {
    const leadId = await resolveLeadId(item.idPrefix);

    const { data: existing } = await db
      .from("qualification")
      .select("fit_score, disqualify_reason, problem_hypothesis")
      .eq("lead_id", leadId)
      .maybeSingle();

    const oldScore = existing?.fit_score ?? null;
    const oldDisqualify = existing?.disqualify_reason ?? null;
    const oldVerdict =
      existing && oldScore != null
        ? verdictFrom({ fit_score: oldScore, disqualify_reason: oldDisqualify })
        : "unknown";

    const rerun = await rerunLead(leadId, systemV4);
    const newVerdict = verdictFrom(rerun.parsed);

    const leadName = `${rerun.lead.first_name ?? ""} ${rerun.lead.last_name ?? ""}`.trim();

    rows.push({
      leadName,
      leadId,
      oldScore,
      newScore: rerun.parsed.fit_score,
      oldVerdict,
      newVerdict,
      oldHypothesis: existing?.problem_hypothesis ?? null,
      newHypothesis: rerun.parsed.problem_hypothesis,
      oldDisqualify,
      newDisqualify: rerun.parsed.disqualify_reason,
    });

    if (oldVerdict !== "unknown" && oldVerdict !== newVerdict) {
      changed.push({
        leadName,
        leadId,
        oldVerdict,
        newVerdict,
        newHypothesis: rerun.parsed.problem_hypothesis,
        newEvidence: rerun.parsed.evidence,
        newDisqualify: rerun.parsed.disqualify_reason,
      });
    }
  }

  console.log("lead name | old score | new score | old verdict | new verdict");
  console.log("---------|----------:|----------:|------------|-----------");
  for (const r of rows) {
    console.log(
      `${r.leadName} | ${r.oldScore ?? "null"} | ${r.newScore} | ${r.oldVerdict} | ${r.newVerdict}`,
    );
  }

  if (changed.length === 0) {
    console.log("\nNo verdict changes.");
    return;
  }

  console.log("\n=== Verdict changes (new output) ===\n");
  for (const c of changed) {
    console.log(`── ${c.leadName} (${c.leadId}) ${c.oldVerdict} → ${c.newVerdict}`);
    console.log(`disqualify_reason: ${c.newDisqualify ?? "null"}`);
    console.log(`hypothesis: ${c.newHypothesis ?? "null"}`);
    console.log(`evidence: ${JSON.stringify(c.newEvidence, null, 2)}`);
    console.log("");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

