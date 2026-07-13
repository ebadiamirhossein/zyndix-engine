import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import {
  assessPersonNames,
  formatPersonNameFailureReason,
} from "../src/lib/stages/source/filters";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);

async function hasLeadEvent(leadId: string, event: string): Promise<boolean> {
  const { count, error } = await db
    .from("lead_events")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("event", event);

  if (error) {
    throw new Error(`lead_events lookup failed for ${leadId}/${event}: ${error.message}`);
  }
  return (count ?? 0) > 0;
}

async function main(): Promise<void> {
  const { data: leads, error } = await db
    .from("leads")
    .select("id, first_name, last_name, do_not_contact");

  if (error) {
    throw new Error(error.message);
  }

  let corrected = 0;
  let suspectEventsWritten = 0;

  for (const lead of leads ?? []) {
    const assessment = assessPersonNames(lead.first_name, lead.last_name);
    const shouldDoNotContact = assessment.doNotContact;
    const wasDoNotContact = lead.do_not_contact === true;
    const lastNameOnlyFailure =
      assessment.nameSuspect && assessment.firstNameValid && !assessment.lastNameValid;

    if (wasDoNotContact && shouldDoNotContact === false && lastNameOnlyFailure) {
      const reason = formatPersonNameFailureReason(assessment.failures);
      const { error: updateError } = await db
        .from("leads")
        .update({ do_not_contact: false })
        .eq("id", lead.id);

      if (updateError) {
        throw new Error(`Failed to correct lead ${lead.id}: ${updateError.message}`);
      }

      const { error: eventError } = await db.from("lead_events").insert({
        lead_id: lead.id,
        event: "name_guard_corrected",
        detail: {
          reason,
          failures: assessment.failures,
          first_name: lead.first_name,
          last_name: lead.last_name,
          previous_do_not_contact: true,
          corrected_do_not_contact: false,
        },
      });

      if (eventError) {
        throw new Error(`Failed to insert name_guard_corrected for ${lead.id}: ${eventError.message}`);
      }

      corrected += 1;
      console.log(
        `CORRECTED ${lead.id} | first="${lead.first_name ?? ""}" last="${lead.last_name ?? ""}" | do_not_contact true→false | reason=${reason}`,
      );
    } else if (lead.do_not_contact !== shouldDoNotContact) {
      const { error: updateError } = await db
        .from("leads")
        .update({ do_not_contact: shouldDoNotContact })
        .eq("id", lead.id);

      if (updateError) {
        throw new Error(`Failed to update lead ${lead.id}: ${updateError.message}`);
      }

      console.log(
        `UPDATED ${lead.id} | do_not_contact ${wasDoNotContact}→${shouldDoNotContact}`,
      );
    }

    if (assessment.nameSuspect && !(await hasLeadEvent(lead.id, "name_suspect"))) {
      const reason = formatPersonNameFailureReason(assessment.failures);
      const { error: eventError } = await db.from("lead_events").insert({
        lead_id: lead.id,
        event: "name_suspect",
        detail: {
          reason,
          failures: assessment.failures,
          do_not_contact: shouldDoNotContact,
          backfill: true,
        },
      });

      if (eventError) {
        throw new Error(`Failed to insert name_suspect for ${lead.id}: ${eventError.message}`);
      }
      suspectEventsWritten += 1;
    }
  }

  const { data: refreshed, error: refreshError } = await db
    .from("leads")
    .select("id, first_name, last_name, do_not_contact");

  if (refreshError) {
    throw new Error(refreshError.message);
  }

  const doNotContactLeads = (refreshed ?? []).filter((lead) => lead.do_not_contact === true);
  const wronglyBlocked = doNotContactLeads.filter((lead) => {
    const assessment = assessPersonNames(lead.first_name, lead.last_name);
    return !assessment.doNotContact;
  });

  console.log(`\nBackfill complete: ${corrected} lead(s) un-flagged (last-name-only failures).`);
  console.log(`name_suspect events written: ${suspectEventsWritten}`);
  console.log(`Leads with do_not_contact=true: ${doNotContactLeads.length}`);
  for (const lead of doNotContactLeads) {
    console.log(
      `  - ${lead.id} | first="${lead.first_name ?? ""}" last="${lead.last_name ?? ""}"`,
    );
  }

  if (wronglyBlocked.length > 0) {
    console.error("ERROR: leads remain do_not_contact=true without first-name failure:");
    for (const lead of wronglyBlocked) {
      console.error(`  - ${lead.id}`);
    }
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("backfill-name-guard FAILED:", message);
  process.exit(1);
});
