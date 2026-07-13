import type { SupabaseClient } from "@supabase/supabase-js";

import type { DatabaseWithSourceCursors } from "@/types/database-extensions";

type Db = SupabaseClient<DatabaseWithSourceCursors>;

export async function readSourcePage(db: Db, segmentKey: string): Promise<number> {
  const { data, error } = await db
    .from("source_cursors")
    .select("page")
    .eq("segment_key", segmentKey)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to read source_cursors for ${segmentKey}: ${error.message} (apply 0004_source_cursors.sql)`,
    );
  }

  return data?.page ?? 1;
}

export async function writeSourcePage(
  db: Db,
  segmentKey: string,
  page: number,
): Promise<void> {
  const { error } = await db.from("source_cursors").upsert(
    {
      segment_key: segmentKey,
      page,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "segment_key" },
  );

  if (error) {
    throw new Error(`Failed to write source_cursors for ${segmentKey}: ${error.message}`);
  }
}
