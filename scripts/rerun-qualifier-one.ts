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

const db = createServiceClient(url, key);
const settings = createSettingsStore(db);
const anthropic = createAnthropicClient();

const LEAD_ID = process.argv[2];
if (!LEAD_ID) {
  console.error("Usage: pnpm tsx scripts/rerun-qualifier-one.ts <lead_id>");
  process.exit(1);
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

function extractSiteText(payload: unknown): string {
  if (!Array.isArray(payload)) {
    return "";
  }
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

async function main(): Promise<void> {
  const [qualifierSetting, icpSetting, segmentsSetting] = await Promise.all([
    settings.getActiveSetting("qualifier_prompt"),
    settings.getActiveSetting("icp_rubric"),
    settings.getActiveSetting("segments"),
  ]);

  const systemPrompt = String(qualifierSetting.value)
    .replace("{{icp_rubric}}", String(icpSetting.value))
    .replace("{{segments}}", JSON.stringify(segmentsSetting.value, null, 2));

  const { data: lead, error: leadError } = await db
    .from("leads")
    .select("id, first_name, last_name, title, companies!inner(name, domain, industry, employee_range, country, city)")
    .eq("id", LEAD_ID)
    .single();

  if (leadError || !lead) {
    throw new Error(`Lead not found: ${leadError?.message ?? "no row"}`);
  }

  const { data: payloadRows, error: payloadError } = await db
    .from("enrichment_payloads")
    .select("source, payload, fetched_at")
    .eq("lead_id", LEAD_ID)
    .order("fetched_at", { ascending: false });

  if (payloadError) {
    throw new Error(`Failed to load enrichment_payloads: ${payloadError.message}`);
  }

  const bySource = new Map((payloadRows ?? []).map((r) => [r.source, r.payload]));
  const sitePayload = bySource.get("apify_site");
  const techPayload = bySource.get("apify_tech");
  const liPayload = bySource.get("apify_li_posts");

  const maxSiteChars = Number.parseInt(process.env.QUALIFY_MAX_SITE_CHARS ?? "20000", 10) || 20000;
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

  const { data: previous } = await db
    .from("qualification")
    .select("problem_hypothesis, evidence, fit_score, segment, disqualify_reason, updated_at")
    .eq("lead_id", LEAD_ID)
    .maybeSingle();

  console.log("=== Previous stored qualification (if any) ===\n");
  console.log(JSON.stringify(previous ?? null, null, 2));

  const completion = await anthropic.complete({
    system: systemPrompt,
    user: JSON.stringify(userInput, null, 2),
    temperature: 0.1,
    maxTokens: 4096,
  });

  const parsed = parseOrThrow(
    qualifierOutputSchema,
    parseJsonText(completion.text),
    `rerun-qualifier-one:${LEAD_ID}`,
  );

  console.log("\n=== New qualifier output (prompt v" + qualifierSetting.version + ") ===\n");
  console.log(JSON.stringify(parsed, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

