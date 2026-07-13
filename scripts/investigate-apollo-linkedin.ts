import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";
import { segmentsSettingsSchema } from "../src/lib/validation/jsonb";
import { parseOrThrow } from "../src/lib/validation";

const APOLLO_BASE_URL = "https://api.apollo.io/api/v1";

function redactEmail(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(redactEmail);
  }
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase().includes("email") && typeof value === "string") {
      out[key] = "[REDACTED]";
    } else {
      out[key] = redactEmail(value);
    }
  }
  return out;
}

function appendArray(params: URLSearchParams, key: string, values: string[]): void {
  for (const value of values) {
    params.append(`${key}[]`, value);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    console.error("Missing APOLLO_API_KEY");
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const db = createServiceClient(url, key);
  const settings = createSettingsStore(db);

  const segmentsSetting = await settings.getActiveSetting("segments");
  const segments = parseOrThrow(segmentsSettingsSchema, segmentsSetting.value, "segments");
  const titles = (segments["us-realestate"]?.apollo_query as { titles?: string[] })?.titles ?? [
    "owner",
    "broker",
  ];

  const { data: company } = await db
    .from("companies")
    .select("id, name, domain, apollo_org_id")
    .not("apollo_org_id", "is", null)
    .limit(1)
    .maybeSingle();

  if (!company?.apollo_org_id) {
    throw new Error("No company with apollo_org_id found in DB");
  }

  console.log(
    `Probing Apollo people search for org ${company.name} (${company.apollo_org_id}) titles=${titles.slice(0, 3).join(", ")}...`,
  );

  const params = new URLSearchParams({
    page: "1",
    per_page: "1",
    include_similar_titles: "true",
  });
  appendArray(params, "organization_ids", [company.apollo_org_id]);
  appendArray(params, "person_titles", titles);

  const requestUrl = `${APOLLO_BASE_URL}/mixed_people/api_search?${params.toString()}`;
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      "Cache-Control": "no-cache",
      accept: "application/json",
      "x-api-key": apiKey,
    },
  });

  const raw = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Apollo ${response.status}: ${JSON.stringify(raw)}`);
  }

  const people = Array.isArray(raw.people) ? raw.people : [];
  const person = people[0];

  console.log("\n=== Raw Apollo mixed_people/api_search response (first person, email redacted) ===");
  if (!person) {
    console.log("No people returned in response.");
    console.dir(redactEmail(raw), { depth: null });
    return;
  }

  console.dir(redactEmail(person), { depth: null });

  const linkedinKeys = Object.keys(person as object).filter((k) =>
    k.toLowerCase().includes("linkedin"),
  );
  console.log("\n=== LinkedIn-related keys on person object ===");
  console.log(linkedinKeys.length ? linkedinKeys.join(", ") : "(none)");

  for (const k of linkedinKeys) {
    console.log(`  ${k}:`, (person as Record<string, unknown>)[k]);
  }

  const { data: dbLead } = await db
    .from("leads")
    .select("id, linkedin_url, apollo_person_id")
    .eq("company_id", company.id)
    .not("apollo_person_id", "is", null)
    .limit(1)
    .maybeSingle();

  console.log("\n=== DB lead for same company ===");
  console.log(
    JSON.stringify(
      {
        lead_id: dbLead?.id,
        linkedin_url: dbLead?.linkedin_url,
        apollo_person_id: dbLead?.apollo_person_id,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("investigate-apollo-linkedin FAILED:", message);
  process.exit(1);
});
