import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { assessPersonNames } from "../src/lib/stages/source/filters";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);

async function main(): Promise<void> {
  const { data: leads, error } = await db
    .from("leads")
    .select("id, first_name, last_name, do_not_contact");

  if (error) {
    throw new Error(error.message);
  }

  const suspects = (leads ?? []).filter((lead) => {
    const assessment = assessPersonNames(lead.first_name, lead.last_name);
    return assessment.nameSuspect;
  });

  console.log(`Total leads: ${leads?.length ?? 0}`);
  console.log(`Suspect names: ${suspects.length}`);

  for (const lead of suspects) {
    const assessment = assessPersonNames(lead.first_name, lead.last_name);
    console.log(
      `  - ${lead.id} | first="${lead.first_name ?? ""}" last="${lead.last_name ?? ""}" | do_not_contact=${lead.do_not_contact} | first_valid=${assessment.firstNameValid} last_valid=${assessment.lastNameValid}`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("audit-suspect-names FAILED:", message);
  process.exit(1);
});
