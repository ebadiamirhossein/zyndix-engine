import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApolloClient } from "@/lib/integrations/apollo";
import { isMaskedApolloEmail } from "@/lib/integrations/apollo-types";
import { checkSuppression } from "@/lib/sending/suppression";
import { readSourcePage, writeSourcePage } from "@/lib/stages/source/cursor";
import {
  assessPersonNames,
  orgDomain,
  orgExcludedByKeywords,
} from "@/lib/stages/source/filters";
import { segmentsSettingsSchema } from "@/lib/validation/jsonb";
import type { LeadState } from "@/types/enums";
import type { Database } from "@/types/database";
import type { DatabaseWithSourceCursors } from "@/types/database-extensions";
import type { z } from "zod";

type SegmentsSettings = z.infer<typeof segmentsSettingsSchema>;

/** States before first send — doc 03 §3 intake throttle. */
export const PRE_SEND_STATES: LeadState[] = [
  "sourced",
  "enriching",
  "qualifying",
  "qualified",
  "verifying",
  "drafting",
  "pending_approval",
  "approved",
  "queued",
];

export type SourceStageSummary = {
  orgs_found: number;
  people_found: number;
  companies_created: number;
  leads_created: number;
  skipped_duplicate: number;
  skipped_suppressed: number;
  skipped_no_domain: number;
  segment: string;
  apollo_page: number;
  apollo_next_page: number;
  apollo_total_entries: number;
  apollo_total_pages: number;
  apollo_org_names: string[];
  segment_exhausted?: boolean;
  pipeline_full?: boolean;
};

type SourceDeps = {
  db: SupabaseClient<DatabaseWithSourceCursors>;
  apollo: ApolloClient;
  getActiveSetting: (key: string) => Promise<{ value: unknown }>;
};

function sourcePageSize(): number {
  const raw = process.env.SOURCE_PAGE_SIZE ?? "25";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
}

function pipelineCap(): number {
  const raw = process.env.SOURCE_PIPELINE_CAP ?? "50";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 50;
}

function resolveActiveSegment(segments: SegmentsSettings): {
  key: string;
  definition: SegmentsSettings[string];
} {
  const active = Object.entries(segments).filter(([, def]) => def.active);
  if (active.length === 0) {
    throw new Error("No active segment in settings");
  }
  if (active.length > 1) {
    throw new Error(
      `Multiple active segments (${active.map(([k]) => k).join(", ")}); only one allowed`,
    );
  }
  const [key, definition] = active[0];
  return { key, definition };
}

// Scope from sending/suppression.ts (U6 fold-in): only a row with no email is
// company-wide, so one invalid address never suppresses a whole company.
async function isSuppressed(
  db: SupabaseClient<DatabaseWithSourceCursors>,
  email: string | null,
  domain: string | null,
): Promise<boolean> {
  const hit = await checkSuppression(db as unknown as SupabaseClient<Database>, { email, companyDomain: domain });
  return hit.email || hit.domain;
}

function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === "23505";
}

async function companyExists(
  db: SupabaseClient<DatabaseWithSourceCursors>,
  domain: string,
  apolloOrgId: string,
): Promise<boolean> {
  const { data } = await db
    .from("companies")
    .select("id")
    .eq("domain", domain)
    .maybeSingle();
  if (data) {
    return true;
  }

  const { data: byApollo } = await db
    .from("companies")
    .select("id")
    .eq("apollo_org_id", apolloOrgId)
    .maybeSingle();

  return Boolean(byApollo);
}

async function leadExistsByApolloPersonId(
  db: SupabaseClient<DatabaseWithSourceCursors>,
  apolloPersonId: string,
): Promise<boolean> {
  const { data } = await db
    .from("leads")
    .select("id")
    .eq("apollo_person_id", apolloPersonId)
    .maybeSingle();

  return Boolean(data);
}

export async function runSourceStage(
  deps: SourceDeps,
  options?: { limit?: number },
): Promise<SourceStageSummary> {
  const limit = options?.limit ?? 5;
  const summary: SourceStageSummary = {
    orgs_found: 0,
    people_found: 0,
    companies_created: 0,
    leads_created: 0,
    skipped_duplicate: 0,
    skipped_suppressed: 0,
    skipped_no_domain: 0,
    segment: "",
    apollo_page: 1,
    apollo_next_page: 1,
    apollo_total_entries: 0,
    apollo_total_pages: 0,
    apollo_org_names: [],
  };

  const segmentsSetting = await deps.getActiveSetting("segments");
  const segments = segmentsSetting.value as SegmentsSettings;
  const { key: segmentKey, definition: segmentDef } = resolveActiveSegment(segments);
  summary.segment = segmentKey;

  const { count: pipelineCount, error: countError } = await deps.db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .in("state", PRE_SEND_STATES);

  if (countError) {
    throw new Error(`Failed to count pre-send pipeline leads: ${countError.message}`);
  }

  const cap = pipelineCap();
  if ((pipelineCount ?? 0) >= cap) {
    console.log(
      `[source] pipeline full (${pipelineCount}/${cap} pre-send leads), skipping source`,
    );
    summary.pipeline_full = true;
    return summary;
  }

  const apolloQuery = segmentDef.apollo_query as {
    industry?: string[];
    employee_range?: string[];
    country?: string;
    titles?: string[];
    exclude_keywords?: string[];
  };

  const titles = apolloQuery.titles ?? [];
  if (titles.length === 0) {
    throw new Error(`Segment ${segmentKey} apollo_query.titles is empty`);
  }

  const pageSize = sourcePageSize();
  const currentPage = await readSourcePage(deps.db, segmentKey);

  const searchResult = await deps.apollo.searchOrganizationsWithMeta(apolloQuery, {
    page: currentPage,
    perPage: pageSize,
  });

  summary.apollo_page = currentPage;
  summary.apollo_total_entries = searchResult.totalEntries;
  summary.apollo_total_pages = searchResult.totalPages;
  summary.apollo_org_names = searchResult.organizations.map((org) => org.name);

  const orgs = searchResult.organizations;
  summary.orgs_found = orgs.length;

  for (const org of orgs) {
    if (summary.leads_created >= limit) {
      break;
    }

    const domain = orgDomain(org);
    if (!domain) {
      console.log(`[source] skipped (no domain): ${org.name}`);
      summary.skipped_no_domain += 1;
      continue;
    }

    if (orgExcludedByKeywords(org, domain, apolloQuery.exclude_keywords)) {
      console.log(`[source] excluded by keyword filter: ${org.name}`);
      continue;
    }

    if (await companyExists(deps.db, domain, org.id)) {
      summary.skipped_duplicate += 1;
      continue;
    }

    const people = await deps.apollo.searchPeople([org.id], titles, {
      perPage: 5,
    });
    summary.people_found += people.length;

    const person = people[0];
    if (!person) {
      continue;
    }

    if (await leadExistsByApolloPersonId(deps.db, person.id)) {
      summary.skipped_duplicate += 1;
      continue;
    }

    const rawEmail = person.email ?? null;
    const email = isMaskedApolloEmail(rawEmail) ? null : rawEmail;

    if (await isSuppressed(deps.db, email, domain)) {
      console.log(
        `[source] suppressed skip: domain=${domain} email=${email ?? "n/a"}`,
      );
      summary.skipped_suppressed += 1;
      continue;
    }

    const lastName =
      person.last_name ??
      (person.last_name_obfuscated
        ? person.last_name_obfuscated.replace(/\*/g, "").trim() || null
        : null);

    const firstName = person.first_name ?? null;
    const nameAssessment = assessPersonNames(firstName, lastName);
    if (nameAssessment.nameSuspect) {
      console.log(
        `[source] name_suspect: first="${firstName ?? ""}" last="${lastName ?? ""}" do_not_contact=${nameAssessment.doNotContact}`,
      );
    }

    const { data: company, error: companyError } = await deps.db
      .from("companies")
      .insert({
        name: org.name,
        domain,
        segment: segmentKey,
        country: org.country ?? apolloQuery.country ?? null,
        city: org.city ?? null,
        industry: org.industry ?? null,
        linkedin_url: org.linkedin_url ?? null,
        apollo_org_id: org.id,
        status: "new",
      })
      .select("id")
      .single();

    if (companyError) {
      if (isUniqueViolation(companyError)) {
        summary.skipped_duplicate += 1;
        continue;
      }
      throw new Error(`Failed to insert company: ${companyError.message}`);
    }
    if (!company) {
      throw new Error("Failed to insert company: no row returned");
    }
    summary.companies_created += 1;

    const { data: lead, error: leadError } = await deps.db
      .from("leads")
      .insert({
        company_id: company.id,
        first_name: firstName,
        last_name: lastName,
        title: person.title ?? null,
        email,
        email_status: "unverified",
        linkedin_url: person.linkedin_url ?? null,
        apollo_person_id: person.id,
        state: "sourced",
        do_not_contact: nameAssessment.doNotContact,
      })
      .select("id")
      .single();

    if (leadError) {
      if (isUniqueViolation(leadError)) {
        await deps.db.from("companies").delete().eq("id", company.id);
        summary.companies_created -= 1;
        summary.skipped_duplicate += 1;
        continue;
      }
      throw new Error(`Failed to insert lead: ${leadError.message}`);
    }
    if (!lead) {
      throw new Error("Failed to insert lead: no row returned");
    }
    summary.leads_created += 1;

    const { error: eventError } = await deps.db.from("lead_events").insert({
      lead_id: lead.id,
      event: "sourced",
      detail: {
        segment: segmentKey,
        apollo_org_id: org.id,
        apollo_person_id: person.id,
      },
    });

    if (eventError) {
      throw new Error(`Failed to insert lead_event: ${eventError.message}`);
    }

    if (nameAssessment.nameSuspect) {
      const { error: suspectEventError } = await deps.db.from("lead_events").insert({
        lead_id: lead.id,
        event: "name_suspect",
        detail: {
          reason: nameAssessment.failures
            .map((f) => `${f.field}: ${f.reason}`)
            .join("; "),
          failures: nameAssessment.failures,
          do_not_contact: nameAssessment.doNotContact,
        },
      });

      if (suspectEventError) {
        throw new Error(`Failed to insert name_suspect lead_event: ${suspectEventError.message}`);
      }
    }
  }

  const exhausted =
    orgs.length === 0 ||
    (searchResult.totalPages > 0
      ? currentPage >= searchResult.totalPages
      : orgs.length < pageSize);
  if (exhausted) {
    console.log(`[source] segment exhausted (${segmentKey}), resetting cursor to page 1`);
    summary.segment_exhausted = true;
    summary.apollo_next_page = 1;
    await writeSourcePage(deps.db, segmentKey, 1);
  } else {
    summary.apollo_next_page = currentPage + 1;
    await writeSourcePage(deps.db, segmentKey, currentPage + 1);
  }

  return summary;
}
