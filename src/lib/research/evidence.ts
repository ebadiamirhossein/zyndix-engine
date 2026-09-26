// Research evidence for the qualify stage (09 §UR): the lead's own items plus
// its company's company-level items, fresh, most recent first, capped; and
// their deterministic mapping onto `qualification.evidence` items.

import type { SupabaseClient } from "@supabase/supabase-js";

import { storedEvidenceItemSchema, type StoredEvidenceItem } from "@/lib/validation/jsonb";
import type { DatabaseWithWave1, EvidenceItemRowShape } from "@/types/database-extensions";
import type { EvidenceSourceType } from "@/types/enums";

/** At most this many research items are appended to one lead's qualification.evidence. */
export const MAX_RESEARCH_EVIDENCE = 8;
/** …and at most this many from any one source type, so one noisy source cannot crowd out the rest. */
export const MAX_RESEARCH_EVIDENCE_PER_SOURCE = 3;

export const RESEARCH_SOURCE_TO_EVIDENCE_SOURCE: Record<EvidenceSourceType, StoredEvidenceItem["source"]> = {
  li_person_post: "linkedin",
  li_company_post: "linkedin",
  li_profile: "linkedin",
  job_post: "jobs",
  google_review: "reviews",
  news: "news",
  blog: "blog",
};

export type ResearchEvidenceRow = Pick<
  EvidenceItemRowShape,
  "id" | "lead_id" | "source_type" | "source_url" | "title" | "excerpt" | "published_at" | "fetched_at"
>;

function ageDays(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 86_400_000;
}

/** Most recent first: by published date (undated last), then by fetch date. Pure. */
export function selectResearchEvidence(
  rows: ResearchEvidenceRow[],
  opts: { now: Date; maxItemAgeDays: number; maxFetchedAgeDays: number; cap?: number; perSourceCap?: number },
): ResearchEvidenceRow[] {
  const cap = opts.cap ?? MAX_RESEARCH_EVIDENCE;
  const perSource = opts.perSourceCap ?? MAX_RESEARCH_EVIDENCE_PER_SOURCE;
  const fresh = rows.filter(
    (r) =>
      ageDays(r.fetched_at, opts.now) <= opts.maxFetchedAgeDays &&
      (r.published_at === null || ageDays(r.published_at, opts.now) <= opts.maxItemAgeDays),
  );
  const sorted = [...fresh].sort((a, b) => {
    const pa = a.published_at ? Date.parse(a.published_at) : -Infinity;
    const pb = b.published_at ? Date.parse(b.published_at) : -Infinity;
    if (pa !== pb) return pb - pa;
    const fa = Date.parse(a.fetched_at);
    const fb = Date.parse(b.fetched_at);
    if (fa !== fb) return fb - fa;
    return a.id.localeCompare(b.id);
  });
  const perCount = new Map<string, number>();
  const out: ResearchEvidenceRow[] = [];
  for (const row of sorted) {
    if (out.length >= cap) break;
    const n = perCount.get(row.source_type) ?? 0;
    if (n >= perSource) continue;
    perCount.set(row.source_type, n + 1);
    out.push(row);
  }
  return out;
}

/** Postgres timestamptz text → ISO with offset (what storedEvidenceItemSchema accepts). */
function iso(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** One research row as a stored qualification.evidence item: observation = the verbatim excerpt. */
export function toStoredEvidenceItem(row: ResearchEvidenceRow): StoredEvidenceItem | null {
  const parsed = storedEvidenceItemSchema.safeParse({
    source: RESEARCH_SOURCE_TO_EVIDENCE_SOURCE[row.source_type],
    observation: row.excerpt,
    source_type: row.source_type,
    evidence_item_id: row.id,
    url: row.source_url,
    published_at: iso(row.published_at),
    fetched_at: iso(row.fetched_at) ?? undefined,
    title: row.title,
  });
  return parsed.success ? parsed.data : null;
}

/** The lead's items and its company's company-level items (lead_id null). */
export async function loadResearchEvidenceRows(
  db: SupabaseClient<DatabaseWithWave1>,
  leadId: string,
  companyId: string,
): Promise<ResearchEvidenceRow[]> {
  const { data, error } = await db
    .from("evidence_items")
    .select("id, lead_id, source_type, source_url, title, excerpt, published_at, fetched_at")
    .eq("company_id", companyId)
    .or(`lead_id.eq.${leadId},lead_id.is.null`)
    .order("fetched_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`evidence_items for lead ${leadId}: ${error.message}`);
  return (data ?? []) as ResearchEvidenceRow[];
}
