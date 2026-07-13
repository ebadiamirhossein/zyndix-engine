import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createApolloClient } from "../src/lib/integrations/apollo";
import {
  apolloPeopleMatchResponseSchema,
  isMaskedApolloEmail,
} from "../src/lib/integrations/apollo-types";
import { parseOrThrow } from "../src/lib/validation";
import { apolloPersonSchema } from "../src/lib/validation/external";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const apollo = createApolloClient();

function parseArgs(): { dry: boolean; leadId: string | undefined } {
  const dry = process.argv.includes("--dry");
  const positional = process.argv.slice(2).filter((arg) => arg !== "--dry");
  return { dry, leadId: positional[0] };
}

function creditsConsumed(raw: unknown): number | null {
  if (typeof raw === "object" && raw !== null && "credits_consumed" in raw) {
    const value = (raw as { credits_consumed: unknown }).credits_consumed;
    return typeof value === "number" ? value : null;
  }
  return null;
}

async function findUnrevealedLeadId(): Promise<string> {
  const { data: leads, error } = await db
    .from("leads")
    .select("id, email, apollo_person_id, state")
    .not("apollo_person_id", "is", null)
    .not("state", "in", '("parked","suppressed")')
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const candidate = (leads ?? []).find(
    (lead) => !lead.email || isMaskedApolloEmail(lead.email),
  );

  if (!candidate) {
    throw new Error("No unrevealed lead with apollo_person_id found");
  }

  return candidate.id;
}

async function main(): Promise<void> {
  const { dry, leadId: leadIdArg } = parseArgs();
  const leadId = leadIdArg ?? (await findUnrevealedLeadId());

  const { data: lead, error: leadError } = await db
    .from("leads")
    .select("id, apollo_person_id, email, email_status, first_name, last_name")
    .eq("id", leadId)
    .single();

  if (leadError || !lead) {
    throw new Error(`Lead not found: ${leadError?.message ?? leadId}`);
  }

  if (!lead.apollo_person_id) {
    throw new Error(`Lead ${leadId} has no apollo_person_id`);
  }

  console.log(
    `[reveal] ${dry ? "DRY RUN — " : ""}people/match for lead ${leadId} (${lead.first_name ?? ""} ${lead.last_name ?? ""}) apollo_person_id=${lead.apollo_person_id}`,
  );
  if (dry) {
    console.log(
      "[reveal] using reveal_personal_emails=false, reveal_phone_number=false (no reveal credit expected)",
    );
  }

  const rawApolloResponse = await apollo.matchPersonRaw(lead.apollo_person_id, {
    revealPersonalEmails: dry ? false : true,
    revealPhoneNumber: false,
  });

  console.log("\n=== Raw Apollo /people/match response ===");
  console.dir(rawApolloResponse, { depth: null });

  const credits = creditsConsumed(rawApolloResponse);
  if (credits !== null) {
    console.log(`\n[reveal] credits_consumed=${credits}`);
  }

  if (dry) {
    console.log("\n[reveal] --dry: exiting without DB write.");
    return;
  }

  const response = parseOrThrow(
    apolloPeopleMatchResponseSchema,
    rawApolloResponse,
    "reveal-email:people/match",
  );

  if (!response.person) {
    throw new Error(`Reveal returned no person for ${lead.apollo_person_id}`);
  }

  const person = parseOrThrow(apolloPersonSchema, response.person, "reveal-email:person");
  const email = person.email ?? null;

  if (!email || isMaskedApolloEmail(email)) {
    throw new Error(`Reveal did not return a usable email for ${lead.apollo_person_id}`);
  }

  const { error: updateError } = await db
    .from("leads")
    .update({
      email,
      email_status: "unverified",
      linkedin_url: person.linkedin_url ?? undefined,
    })
    .eq("id", leadId);

  if (updateError) {
    throw new Error(`Failed to update lead: ${updateError.message}`);
  }

  console.log(`\n[reveal] wrote email to lead ${leadId}: ${email}`);
  if (person.linkedin_url) {
    console.log(`[reveal] wrote linkedin_url: ${person.linkedin_url}`);
  }
  console.log("[reveal] done — check Apollo dashboard for credit usage");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("reveal-email FAILED:", message);
  process.exit(1);
});
