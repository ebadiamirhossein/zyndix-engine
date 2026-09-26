import type { SupabaseClient } from "@supabase/supabase-js";

import { WebhookProcessingError } from "@/lib/webhooks/exceptions";
import type { DatabaseWithWave1, DatabaseWithWebhooks, MeetingRowShape } from "@/types/database-extensions";

// The /dashboard/pipeline meetings list (09 §U8). Read-only.

export type MeetingListItem = Pick<
  MeetingRowShape,
  "id" | "status" | "start_at" | "end_at" | "event_name" | "invitee_email" | "invitee_name" | "lead_id" | "company_id" | "outcome_recorded_by"
> & { lead_name: string | null; lead_state: string | null; company_name: string | null };

export async function listMeetings(db: SupabaseClient<DatabaseWithWave1>, limit = 200): Promise<MeetingListItem[]> {
  const { data, error } = await db
    .from("meetings")
    .select("id, status, start_at, end_at, event_name, invitee_email, invitee_name, lead_id, company_id, outcome_recorded_by")
    .order("start_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new WebhookProcessingError(`list meetings: ${error.message}`);
  const rows = data ?? [];
  const wdb = db as unknown as SupabaseClient<DatabaseWithWebhooks>;

  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter((id): id is string => Boolean(id)))];
  const leads = new Map<string, { name: string | null; state: string; company_id: string | null }>();
  if (leadIds.length) {
    const { data: leadRows, error: leadError } = await wdb.from("leads").select("id, first_name, last_name, state, company_id").in("id", leadIds);
    if (leadError) throw new WebhookProcessingError(`list meetings leads: ${leadError.message}`);
    for (const l of leadRows ?? []) {
      const name = [l.first_name, l.last_name].filter(Boolean).join(" ") || null;
      leads.set(l.id, { name, state: l.state, company_id: l.company_id });
    }
  }
  const companyIds = [
    ...new Set(rows.map((r) => r.company_id ?? (r.lead_id ? leads.get(r.lead_id)?.company_id : null)).filter((id): id is string => Boolean(id))),
  ];
  const companies = new Map<string, string | null>();
  if (companyIds.length) {
    const { data: companyRows, error: companyError } = await wdb.from("companies").select("id, name").in("id", companyIds);
    if (companyError) throw new WebhookProcessingError(`list meetings companies: ${companyError.message}`);
    for (const c of companyRows ?? []) companies.set(c.id, c.name);
  }

  return rows.map((r) => {
    const lead = r.lead_id ? leads.get(r.lead_id) : undefined;
    const companyId = r.company_id ?? lead?.company_id ?? null;
    return {
      ...r,
      lead_name: lead?.name ?? null,
      lead_state: lead?.state ?? null,
      company_name: companyId ? (companies.get(companyId) ?? null) : null,
    };
  });
}
