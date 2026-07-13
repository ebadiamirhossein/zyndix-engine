import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);

const LEAD_ID = "b48ad46e-c965-4603-b00b-31b569706284";
const NEEDLE = "We have a branch in Houston";

async function main(): Promise<void> {
  const { data: rows, error } = await db
    .from("enrichment_payloads")
    .select("id, source, fetched_at, payload")
    .eq("lead_id", LEAD_ID)
    .order("fetched_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load enrichment_payloads: ${error.message}`);
  }

  console.log(`Found ${rows?.length ?? 0} enrichment_payloads rows for lead ${LEAD_ID}`);

  let found = false;
  let foundRow: { id: string; source: string | null; fetched_at: string | null } | null =
    null;

  for (const row of rows ?? []) {
    const payloadStr = JSON.stringify(row.payload ?? null);
    const hasNeedle = payloadStr.includes(NEEDLE);
    if (hasNeedle && !foundRow) {
      foundRow = { id: row.id, source: row.source, fetched_at: row.fetched_at };
      found = true;
    }

    console.log("\n---");
    console.log(
      JSON.stringify(
        {
          id: row.id,
          source: row.source,
          fetched_at: row.fetched_at,
          hasNeedle,
        },
        null,
        2,
      ),
    );
    console.log(payloadStr);
  }

  console.log("\n=== SEARCH RESULT ===");
  if (found) {
    console.log(`FOUND: "${NEEDLE}"`);
    console.log(JSON.stringify(foundRow, null, 2));
  } else {
    console.log(`NOT FOUND: "${NEEDLE}"`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

