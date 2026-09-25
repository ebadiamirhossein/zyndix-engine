import type { SupabaseClient } from "@supabase/supabase-js";

import { createApolloClient } from "@/lib/integrations/apollo";
import type { MillionVerifierClient } from "@/lib/integrations/millionverifier";
import { checkSuppression } from "@/lib/sending/suppression";
import { createStateStore } from "@/lib/state/core";
import { assessPersonNames } from "@/lib/stages/source/filters";
import type { Database, Json } from "@/types/database";

export type VerifyStageSummary = {
  leads_picked: number;
  revealed: number;
  apollo_credits_spent: number;
  valid: number;
  invalid: number;
  catch_all: number;
  suppressed_skipped: number;
  parked: number;
  failed: number;
};

type VerifyDeps = {
  db: SupabaseClient<Database>;
  millionverifier: MillionVerifierClient;
  transition: ReturnType<typeof createStateStore>["transition"];
};

type LeadPick = {
  id: string;
  company_id: string;
  apollo_person_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  linkedin_url: string | null;
  do_not_contact: boolean | null;
  companies: { domain: string | null; name: string };
};

function verifyBatchSize(): number {
  const raw = process.env.VERIFY_BATCH_SIZE ?? "5";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function revealCap(): number {
  const raw = process.env.APOLLO_MAX_REVEALS_PER_RUN ?? "5";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 5;
}

// Person-level vs company-wide scope comes from sending/suppression.ts (U6
// fold-in): a row with an email suppresses that address only, even though this
// stage writes the domain beside an invalid address. Lookup errors throw —
// suppression fails closed.
async function isSuppressed(
  db: SupabaseClient<Database>,
  email: string | null,
  domain: string | null,
  linkedinUrl: string | null,
): Promise<boolean> {
  const hit = await checkSuppression(db, { email, companyDomain: domain });
  if (hit.email || hit.domain) return true;

  if (linkedinUrl) {
    const { data, error } = await db
      .from("suppression_list")
      .select("id")
      .eq("linkedin_url", linkedinUrl)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`suppression lookup (linkedin) failed: ${error.message}`);
    if (data) return true;
  }

  return false;
}

async function countVerifyFailures(
  db: SupabaseClient<Database>,
  leadId: string,
): Promise<number> {
  const { count, error } = await db
    .from("lead_events")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("event", "verify_failed");

  if (error) {
    throw new Error(`Failed to count verify_failed for ${leadId}: ${error.message}`);
  }
  return count ?? 0;
}

async function parkCompany(
  db: SupabaseClient<Database>,
  companyId: string,
  parkReason: string,
): Promise<void> {
  const { error } = await db
    .from("companies")
    .update({ park_reason: parkReason, status: "parked" })
    .eq("id", companyId);
  if (error) {
    throw new Error(`Failed to park company ${companyId}: ${error.message}`);
  }
}

function domainFromEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  return email.slice(at + 1).toLowerCase();
}

export async function runVerifyStage(
  deps: VerifyDeps,
  options?: { limit?: number },
): Promise<VerifyStageSummary> {
  const batchCap = options?.limit ?? verifyBatchSize();
  const cap = revealCap();
  const apollo = createApolloClient();

  const summary: VerifyStageSummary = {
    leads_picked: 0,
    revealed: 0,
    apollo_credits_spent: 0,
    valid: 0,
    invalid: 0,
    catch_all: 0,
    suppressed_skipped: 0,
    parked: 0,
    failed: 0,
  };

  const { data: rows, error: pickError } = await deps.db
    .from("leads")
    .select(
      "id, company_id, apollo_person_id, email, first_name, last_name, linkedin_url, do_not_contact, companies!inner(domain, name)",
    )
    .eq("state", "qualified")
    .order("created_at", { ascending: true })
    .limit(batchCap);

  if (pickError) {
    throw new Error(`Failed to pick qualified leads: ${pickError.message}`);
  }

  const leads: LeadPick[] = (rows ?? []).map((row) => ({
    id: row.id,
    company_id: row.company_id!,
    apollo_person_id: row.apollo_person_id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    linkedin_url: row.linkedin_url,
    do_not_contact: row.do_not_contact,
    companies: row.companies as LeadPick["companies"],
  }));

  summary.leads_picked = leads.length;
  if (leads.length === 0) {
    console.log("[verify] no qualified leads to process");
    return summary;
  }

  let revealsThisRun = 0;

  for (const lead of leads) {
    try {
      const suppressed = await isSuppressed(
        deps.db,
        lead.email,
        lead.companies.domain,
        lead.linkedin_url,
      );

      if (suppressed) {
        await deps.transition(lead.id, "qualified", "suppressed", "suppressed", {
          reason: "suppression_recheck_before_reveal",
        });
        summary.suppressed_skipped += 1;
        continue;
      }

      if (!lead.apollo_person_id) {
        await parkCompany(deps.db, lead.company_id, "no_apollo_person_id");
        await deps.transition(lead.id, "qualified", "parked", "parked", {
          park_reason: "no_apollo_person_id",
        });
        summary.parked += 1;
        continue;
      }

      if (revealsThisRun + 1 > cap) {
        throw new Error(
          `Hard cap exceeded: would spend ${revealsThisRun + 1} reveals (max ${cap})`,
        );
      }

      // Reveal
      const revealed = await apollo.revealPersonEmail(lead.apollo_person_id);
      revealsThisRun += 1;
      summary.apollo_credits_spent += 1;

      const newEmail = revealed.email?.trim() ?? null;
      const newFirst = revealed.first_name?.trim() ?? null;
      const newLast = revealed.last_name?.trim() ?? null;
      const newLinkedIn = revealed.linkedin_url?.trim() ?? null;

      await deps.db.from("lead_events").insert({
        lead_id: lead.id,
        event: "reveal_completed",
        detail: {
          apollo_person_id: lead.apollo_person_id,
          email: newEmail,
          first_name: newFirst,
          last_name: newLast,
          linkedin_url: newLinkedIn,
        },
      });

      summary.revealed += 1;

      if (!newEmail) {
        await parkCompany(deps.db, lead.company_id, "no_email_found");
        await deps.transition(lead.id, "qualified", "parked", "parked", {
          park_reason: "no_email_found",
        });
        summary.parked += 1;
        continue;
      }

      // Update lead identity fields from reveal if they are fuller.
      const shouldUpdateFirst =
        newFirst && (!lead.first_name || newFirst.length > lead.first_name.length);
      const shouldUpdateLast =
        newLast && (!lead.last_name || newLast.length > lead.last_name.length);

      const { error: updateError } = await deps.db
        .from("leads")
        .update({
          email: newEmail,
          first_name: shouldUpdateFirst ? newFirst : lead.first_name,
          last_name: shouldUpdateLast ? newLast : lead.last_name,
          linkedin_url: newLinkedIn ?? lead.linkedin_url,
        })
        .eq("id", lead.id);

      if (updateError) {
        throw new Error(`Failed to update lead after reveal: ${updateError.message}`);
      }

      // Re-run name guard and clear do_not_contact if first name is now clean.
      const assessed = assessPersonNames(
        shouldUpdateFirst ? newFirst : lead.first_name,
        shouldUpdateLast ? newLast : lead.last_name,
      );

      if (lead.do_not_contact && assessed.firstNameValid) {
        const { error: dncError } = await deps.db
          .from("leads")
          .update({ do_not_contact: false })
          .eq("id", lead.id);

        if (dncError) {
          throw new Error(`Failed to clear do_not_contact: ${dncError.message}`);
        }

        await deps.db.from("lead_events").insert({
          lead_id: lead.id,
          event: "name_guard_cleared",
          detail: {
            previous_do_not_contact: true,
            corrected_do_not_contact: false,
            first_name: shouldUpdateFirst ? newFirst : lead.first_name,
            last_name: shouldUpdateLast ? newLast : lead.last_name,
          },
        });
      }

      // Verify
      const verification = await deps.millionverifier.verifyEmail(newEmail);

      await deps.db.from("lead_events").insert({
        lead_id: lead.id,
        event: "verify_completed",
        detail: {
          email: newEmail,
          millionverifier_result: verification.raw_result,
          millionverifier_quality: verification.quality,
          millionverifier_subresult: verification.subresult,
          millionverifier_resultcode: verification.resultcode,
          millionverifier_didyoumean: verification.didyoumean,
          mapped_email_status: verification.email_status,
        },
      });

      const verifiedAt = new Date().toISOString();

      if (verification.email_status === "invalid") {
        const { error: updateInvalidError } = await deps.db
          .from("leads")
          .update({
            email_status: "invalid",
            email_verified_at: verifiedAt,
          })
          .eq("id", lead.id);

        if (updateInvalidError) {
          throw new Error(`Failed to set invalid email status: ${updateInvalidError.message}`);
        }

        const suppressDomain = domainFromEmail(newEmail);
        const { error: suppressError } = await deps.db.from("suppression_list").insert({
          email: newEmail,
          domain: suppressDomain,
          linkedin_url: newLinkedIn ?? lead.linkedin_url,
          reason: "invalid_email",
        });

        if (suppressError) {
          throw new Error(`Failed to insert suppression_list: ${suppressError.message}`);
        }

        await parkCompany(deps.db, lead.company_id, "email_invalid");
        await deps.transition(lead.id, "qualified", "parked", "parked", {
          park_reason: "email_invalid",
          email: newEmail,
        });

        summary.invalid += 1;
        summary.parked += 1;
        continue;
      }

      // valid or catch_all both proceed to drafting, but catch_all is flagged.
      const { error: updateOkError } = await deps.db
        .from("leads")
        .update({
          email_status: verification.email_status,
          email_verified_at: verifiedAt,
        })
        .eq("id", lead.id);

      if (updateOkError) {
        throw new Error(`Failed to set email status: ${updateOkError.message}`);
      }

      if (verification.email_status === "catch_all") {
        await deps.db.from("lead_events").insert({
          lead_id: lead.id,
          event: "catch_all_flagged",
          detail: { email: newEmail, millionverifier_result: verification.raw_result },
        });
        summary.catch_all += 1;
      } else {
        summary.valid += 1;
      }

      await deps.transition(lead.id, "qualified", "verifying", "verify_started", {
        email: newEmail,
        email_status: verification.email_status,
      });
      await deps.transition(lead.id, "verifying", "drafting", "verified", {
        email: newEmail,
        email_status: verification.email_status,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const priorFailures = await countVerifyFailures(deps.db, lead.id);
      const attempt = priorFailures + 1;

      await deps.db.from("lead_events").insert({
        lead_id: lead.id,
        event: "verify_failed",
        detail: { error: message, attempt },
      });

      if (attempt >= 3) {
        await parkCompany(deps.db, lead.company_id, "verify_failed_3x");
        await deps.transition(lead.id, "qualified", "parked", "verify_failed", {
          park_reason: "verify_failed_3x",
          error: message,
          attempt,
        });
        summary.parked += 1;
      } else {
        const retryAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const { error: retryError } = await deps.db
          .from("leads")
          .update({ next_action_at: retryAt })
          .eq("id", lead.id);

        if (retryError) {
          throw new Error(`Failed to schedule verify retry for ${lead.id}: ${retryError.message}`);
        }
        summary.failed += 1;
        console.log(
          `[verify] lead ${lead.id} verify_failed attempt ${attempt}/3, retry at ${retryAt}`,
        );
      }
    }
  }

  return summary;
}

