import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import {
  clearSettingsCache,
  createSettingsStore,
} from "../src/lib/settings/core";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const settings = createSettingsStore(db);

const TEST_KEY = "icp_rubric";

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const v1 = await settings.getActiveSetting(TEST_KEY);
  assert(
    `getActiveSetting('${TEST_KEY}') returns v1`,
    v1.version === 1,
    `got v${v1.version}`,
  );

  const v2 = await settings.writeNewVersion(
    TEST_KEY,
    v1.value,
    "test",
    "test-settings bump to v2",
  );
  assert(
    "writeNewVersion creates v2 active",
    v2.version === 2 && v2.key === TEST_KEY,
    `got v${v2.version}`,
  );

  const { data: v1Row, error: v1Error } = await db
    .from("settings")
    .select("id, version, active")
    .eq("key", TEST_KEY)
    .eq("version", 1)
    .single();

  assert(
    "v1 still exists with active=false",
    !v1Error && v1Row?.active === false,
    v1Error?.message,
  );

  const activeAfterWrite = await settings.getActiveSetting(TEST_KEY);
  assert(
    "getActiveSetting returns v2 after write (cache cleared)",
    activeAfterWrite.version === 2,
    `got v${activeAfterWrite.version}`,
  );

  let emptyNoteThrew = false;
  try {
    await settings.writeNewVersion(TEST_KEY, v1.value, "test", "   ");
  } catch {
    emptyNoteThrew = true;
  }
  assert("writeNewVersion throws on empty change_note", emptyNoteThrew);

  let missingKeyThrew = false;
  try {
    await settings.getActiveSetting("does-not-exist");
  } catch (error) {
    missingKeyThrew =
      error instanceof Error &&
      error.message.includes('No active setting found for key "does-not-exist"');
  }
  assert("getActiveSetting('does-not-exist') throws", missingKeyThrew);

  const { data: activeRows, error: activeCountError } = await db
    .from("settings")
    .select("id")
    .eq("key", TEST_KEY)
    .eq("active", true);

  assert(
    "exactly one active row per key",
    !activeCountError && (activeRows?.length ?? 0) === 1,
    activeCountError?.message ?? `count=${activeRows?.length}`,
  );

  // Cleanup: v1 active again, delete v2 test row
  const { data: v2Row, error: v2ReadError } = await db
    .from("settings")
    .select("id")
    .eq("key", TEST_KEY)
    .eq("version", 2)
    .single();

  if (v2ReadError || !v2Row || !v1Row) {
    throw new Error(`Cleanup failed: could not locate v1/v2 rows (${v2ReadError?.message})`);
  }

  const { error: deactivateV2Error } = await db
    .from("settings")
    .update({ active: false })
    .eq("id", v2Row.id);

  if (deactivateV2Error) {
    throw new Error(`Cleanup deactivate v2 failed: ${deactivateV2Error.message}`);
  }

  const { error: activateV1Error } = await db
    .from("settings")
    .update({ active: true })
    .eq("id", v1Row.id);

  if (activateV1Error) {
    throw new Error(`Cleanup activate v1 failed: ${activateV1Error.message}`);
  }

  const { error: deleteV2Error } = await db
    .from("settings")
    .delete()
    .eq("id", v2Row.id);

  if (deleteV2Error) {
    throw new Error(`Cleanup delete v2 failed: ${deleteV2Error.message}`);
  }

  clearSettingsCache();

  const restored = await settings.getActiveSetting(TEST_KEY);
  assert(
    "cleanup restored v1 active",
    restored.version === 1,
    `got v${restored.version}`,
  );

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} test(s) failed.`);
    process.exit(1);
  }

  console.log(`\nAll ${results.length} checks passed.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("test-settings FAILED:", message);
  process.exit(1);
});
