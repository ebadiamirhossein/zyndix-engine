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

function previewValue(value: unknown): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length <= 80 ? text : `${text.slice(0, 80)}…`;
}

async function main(): Promise<void> {
  const { data, error } = await db
    .from("settings")
    .select("key, version, changed_by, change_note, updated_at, value")
    .eq("active", true)
    .order("key");

  if (error) {
    console.error("show-settings FAILED:", error.message);
    process.exit(1);
  }

  if (!data?.length) {
    console.log("No active settings rows found.");
    return;
  }

  const rows = data.map((row) => ({
    key: row.key,
    version: row.version,
    changed_by: row.changed_by ?? "",
    change_note: row.change_note ?? "",
    updated_at: row.updated_at ?? "",
    value_preview: previewValue(row.value),
  }));

  console.log(
    [
      "key".padEnd(28),
      "ver",
      "changed_by".padEnd(10),
      "updated_at".padEnd(26),
      "change_note",
      "value (80 chars)",
    ].join(" | "),
  );
  console.log("-".repeat(140));

  for (const row of rows) {
    console.log(
      [
        row.key.padEnd(28),
        String(row.version).padStart(3),
        row.changed_by.padEnd(10),
        row.updated_at.padEnd(26),
        row.change_note.slice(0, 40),
        row.value_preview,
      ].join(" | "),
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("show-settings FAILED:", message);
  process.exit(1);
});
