import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import { allowedRoleFor, parseAllowedEmails } from "../src/lib/auth/allowlist";
import {
  ForbiddenError,
  ROLE_RANK,
  assertRole,
  createAuthStore,
} from "../src/lib/auth/core";
import { MUTATING_ROUTES, sessionRoutes } from "../src/lib/auth/route-registry";
import { APP_ROLES, type AppRole } from "../src/types/enums";
import type { DatabaseWithAppUsers } from "../src/types/database-extensions";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key) as unknown as SupabaseClient<DatabaseWithAppUsers>;
const store = createAuthStore(db);

// ---------------------------------------------------------------------------
// Harness (same shape as test-state.ts / test-validation.ts)
// ---------------------------------------------------------------------------

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];
const skipped: string[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name: string, why: string): void {
  skipped.push(`${name} — ${why}`);
  console.log(`SKIP: ${name} — ${why}`);
}

function parseBaseUrl(argv: string[]): string | null {
  const idx = argv.indexOf("--base-url");
  if (idx !== -1 && argv[idx + 1]) {
    return argv[idx + 1].replace(/\/$/, "");
  }
  return process.env.U1_BASE_URL?.replace(/\/$/, "") ?? null;
}

const FIXTURE_TAG = `u1-auth-${Date.now()}`;
const fixtureEmail = (role: AppRole): string => `${FIXTURE_TAG}-${role}@example.com`;

async function migrationApplied(): Promise<boolean> {
  // Deliberately NOT a head:true request. PostgREST answers a head request
  // against a missing table with 204, no error and a null count — so a head
  // probe reports a table that does not exist as an empty one. A body select
  // returns the real 404/PGRST205.
  const { error } = await db.from("app_users").select("id").limit(1);
  if (!error) {
    return true;
  }
  if (error.code === "PGRST205" || error.message.includes("schema cache")) {
    return false;
  }
  throw new Error(`app_users probe failed: ${error.message}`);
}

async function countRows(table: "leads" | "touches" | "lead_events" | "app_users"): Promise<number> {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) {
    throw new Error(`count ${table} failed: ${error.message}`);
  }
  if (count === null) {
    // See migrationApplied(): a head request against a missing table succeeds
    // with a null count. Returning 0 here would let a before/after comparison
    // pass against a table that is not there.
    throw new Error(`count ${table} returned null — does the table exist?`);
  }
  return count;
}

async function main(): Promise<void> {
  const baseUrl = parseBaseUrl(process.argv.slice(2));
  console.log(`\n=== test-u1-auth (base-url=${baseUrl ?? "none"}) ===\n`);

  // -------------------------------------------------------------------------
  // Group 1 — allow-list parsing (pure)
  // -------------------------------------------------------------------------
  console.log("--- allow-list parsing ---");

  const parsed = parseAllowedEmails("Amir@Zyndix.com:admin, ops@zyndix.com:operator ,tmp@zyndix.com");
  assert("allow-list parses three entries", parsed.size === 3, `size=${parsed.size}`);
  assert("email is lower-cased", parsed.has("amir@zyndix.com"));
  assert("explicit role honoured", parsed.get("amir@zyndix.com") === "admin", parsed.get("amir@zyndix.com"));
  assert("operator role honoured", parsed.get("ops@zyndix.com") === "operator", parsed.get("ops@zyndix.com"));
  assert("bare email defaults to viewer", parsed.get("tmp@zyndix.com") === "viewer", parsed.get("tmp@zyndix.com"));

  const typo = parseAllowedEmails("x@zyndix.com:admn");
  assert(
    "unrecognised role suffix falls back to viewer, not admin",
    typo.get("x@zyndix.com") === "viewer",
    typo.get("x@zyndix.com"),
  );

  assert("empty env yields empty allow-list", parseAllowedEmails("").size === 0);
  assert("garbage entry without @ is dropped", parseAllowedEmails("nonsense").size === 0);
  assert("non-listed email is refused", allowedRoleFor("nobody@zyndix.com", parsed) === null);
  assert("listed email resolves regardless of case", allowedRoleFor("  AMIR@zyndix.com ", parsed) === "admin");

  // -------------------------------------------------------------------------
  // Group 2 — role ranking and assertRole (pure). This is the authorization rule.
  // -------------------------------------------------------------------------
  console.log("\n--- assertRole matrix ---");

  assert(
    "ROLE_RANK orders viewer < operator < admin",
    ROLE_RANK.viewer < ROLE_RANK.operator && ROLE_RANK.operator < ROLE_RANK.admin,
    JSON.stringify(ROLE_RANK),
  );

  function throwsForbidden(actual: AppRole | null, required: AppRole): boolean {
    try {
      assertRole(actual, required);
      return false;
    } catch (error: unknown) {
      return error instanceof ForbiddenError && error.status === 403;
    }
  }

  // Every (actual, required) pair, asserted by name rather than by spot check.
  for (const actual of APP_ROLES) {
    for (const required of APP_ROLES) {
      const shouldPass = ROLE_RANK[actual] >= ROLE_RANK[required];
      const threw = throwsForbidden(actual, required);
      assert(
        `${actual} ${shouldPass ? "may" : "may NOT"} act as ${required}`,
        threw === !shouldPass,
      );
    }
  }

  assert("no role at all is forbidden, not allowed", throwsForbidden(null, "viewer"));
  assert("viewer is refused operator", throwsForbidden("viewer", "operator"));
  assert("operator is refused admin", throwsForbidden("operator", "admin"));

  // -------------------------------------------------------------------------
  // Group 3 — route registry
  // -------------------------------------------------------------------------
  console.log("\n--- route registry ---");

  assert("registry is non-empty", MUTATING_ROUTES.length > 0, `${MUTATING_ROUTES.length} route(s)`);
  assert(
    "every registry entry is classified session or machine",
    MUTATING_ROUTES.every((r) => r.auth === "session" || r.auth === "machine"),
  );
  assert(
    "every session route names a required role",
    sessionRoutes().every((r) => (APP_ROLES as readonly string[]).includes(r.role)),
  );

  // Any route.ts under src/app/api that exports a mutating verb must be registered.
  const { execSync } = await import("node:child_process");
  const routeFiles = execSync("find src/app/api -name route.ts", { encoding: "utf-8" })
    .split("\n")
    .filter(Boolean);
  const unregistered: string[] = [];
  for (const file of routeFiles) {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(file, "utf-8");
    if (!/export\s+async\s+function\s+(POST|PATCH|PUT|DELETE)/.test(source)) {
      continue;
    }
    const routePath = "/" + file.replace(/^src\/app\//, "").replace(/\/route\.ts$/, "");
    if (!MUTATING_ROUTES.some((r) => r.path === routePath)) {
      unregistered.push(routePath);
    }
  }
  assert(
    "every mutating route on disk is in the registry",
    unregistered.length === 0,
    unregistered.length ? `unregistered: ${unregistered.join(", ")}` : `${routeFiles.length} route file(s) scanned`,
  );

  // -------------------------------------------------------------------------
  // Group 4 — app_users store, against the real schema
  // -------------------------------------------------------------------------
  console.log("\n--- app_users store ---");

  const applied = await migrationApplied();
  if (!applied) {
    skip("app_users store (14 checks)", "0005_app_users_roles.sql not applied yet");
    skip("source_cursors trigger (5 checks)", "0005_app_users_roles.sql not applied yet");
  }

  if (applied) {
  const before = {
    leads: await countRows("leads"),
    touches: await countRows("touches"),
    lead_events: await countRows("lead_events"),
    app_users: await countRows("app_users"),
  };
  console.log(
    `BEFORE  leads=${before.leads} touches=${before.touches} lead_events=${before.lead_events} app_users=${before.app_users}`,
  );

  const createdUserIds: string[] = [];

  try {
    for (const role of APP_ROLES) {
      const email = fixtureEmail(role);
      const { data, error } = await db.auth.admin.createUser({
        email,
        email_confirm: true,
      });
      if (error || !data.user) {
        throw new Error(`createUser(${email}) failed: ${error?.message ?? "no user"}`);
      }
      createdUserIds.push(data.user.id);
    }
    assert("three synthetic auth users created", createdUserIds.length === 3);

    const viewerId = createdUserIds[0];
    const operatorId = createdUserIds[1];

    assert("unprovisioned user has no app_users row", (await store.getAppUser(viewerId)) === null);

    const provisioned = await store.ensureAppUser({
      userId: viewerId,
      email: fixtureEmail("viewer"),
      role: "viewer",
    });
    assert("ensureAppUser provisions with the given role", provisioned.role === "viewer", provisioned.role);

    const reread = await store.getAppUser(viewerId);
    assert("getAppUser returns the provisioned row", reread?.userId === viewerId);

    // The no-overwrite rule: an env change must not silently re-grant.
    const second = await store.ensureAppUser({
      userId: viewerId,
      email: fixtureEmail("viewer"),
      role: "admin",
    });
    assert(
      "ensureAppUser does NOT overwrite an existing role from the env",
      second.role === "viewer",
      `role stayed ${second.role}`,
    );
    assert("ensureAppUser is idempotent — no duplicate row", (await countRows("app_users")) === before.app_users + 1);

    // A promoted role is what requireRole then sees.
    const { error: promoteError } = await db
      .from("app_users")
      .update({ role: "operator" })
      .eq("user_id", viewerId);
    assert("role can be promoted by DB update", !promoteError, promoteError?.message);
    const promoted = await store.getAppUser(viewerId);
    assert("promotion is visible to getAppUser", promoted?.role === "operator", promoted?.role);
    assert("promoted user now passes the operator gate", !throwsForbidden(promoted?.role ?? null, "operator"));

    // The check constraint is the privilege boundary.
    const { error: badRole } = await db
      .from("app_users")
      .insert({ user_id: operatorId, email: fixtureEmail("operator"), role: "superuser" as AppRole });
    assert(
      "an unrecognised role is rejected by the check constraint",
      badRole?.code === "23514",
      badRole ? `${badRole.code}: ${badRole.message.slice(0, 60)}` : "insert unexpectedly succeeded",
    );
  } finally {
    for (const userId of createdUserIds) {
      const { error } = await db.auth.admin.deleteUser(userId);
      if (error) {
        throw new Error(`Cleanup deleteUser(${userId}) failed: ${error.message}`);
      }
    }
    console.log(`Cleanup: removed ${createdUserIds.length} synthetic auth user(s).`);
  }

  // ON DELETE CASCADE should have taken the app_users rows with them.
  const after = {
    leads: await countRows("leads"),
    touches: await countRows("touches"),
    lead_events: await countRows("lead_events"),
    app_users: await countRows("app_users"),
  };
  console.log(
    `AFTER   leads=${after.leads} touches=${after.touches} lead_events=${after.lead_events} app_users=${after.app_users}`,
  );

  assert("leads count unchanged", before.leads === after.leads, `${before.leads} → ${after.leads}`);
  assert("touches count unchanged", before.touches === after.touches, `${before.touches} → ${after.touches}`);
  assert(
    "lead_events count unchanged",
    before.lead_events === after.lead_events,
    `${before.lead_events} → ${after.lead_events}`,
  );
  assert(
    "app_users count unchanged — FK cascade cleaned up",
    before.app_users === after.app_users,
    `${before.app_users} → ${after.app_users}`,
  );
  }

  // -------------------------------------------------------------------------
  // Group 4b — source_cursors, the other half of migration 0005
  //
  // Targeted regression for the new trg_updated_at. scripts/test-source.ts would
  // also exercise this, but it calls Apollo and creates real leads, so it sits
  // behind the cost gate; this proves the same thing for free.
  // -------------------------------------------------------------------------
  console.log("\n--- source_cursors trigger ---");

  const cursorKey = `${FIXTURE_TAG}-segment`;
  const OLD_TS = "2020-01-01T00:00:00.000Z";

  if (applied) {
  try {
    const { error: insErr } = await db
      .from("source_cursors")
      .insert({ segment_key: cursorKey, page: 1, updated_at: OLD_TS });
    assert("service_role can still write source_cursors with RLS on", !insErr, insErr?.message);

    const { data: inserted } = await db
      .from("source_cursors")
      .select("page, updated_at")
      .eq("segment_key", cursorKey)
      .single();
    assert(
      "insert keeps the app-supplied updated_at (trigger is BEFORE UPDATE only)",
      inserted?.updated_at?.startsWith("2020-01-01") === true,
      inserted?.updated_at ?? "null",
    );

    const { error: updErr } = await db
      .from("source_cursors")
      .update({ page: 2 })
      .eq("segment_key", cursorKey);
    assert("source_cursors row updates", !updErr, updErr?.message);

    const { data: updated } = await db
      .from("source_cursors")
      .select("page, updated_at")
      .eq("segment_key", cursorKey)
      .single();
    assert("update applied", updated?.page === 2, String(updated?.page));

    const movedOn =
      updated?.updated_at != null && Date.parse(updated.updated_at) > Date.parse(OLD_TS);
    assert(
      "trg_updated_at fired on update — updated_at advanced",
      movedOn,
      updated?.updated_at ?? "null",
    );
  } finally {
    const { error } = await db.from("source_cursors").delete().eq("segment_key", cursorKey);
    if (error) {
      throw new Error(`Cleanup source_cursors failed: ${error.message}`);
    }
    console.log("Cleanup: removed fixture source_cursors row.");
  }
  }

  // -------------------------------------------------------------------------
  // Group 5 — HTTP surface (needs a running server)
  // -------------------------------------------------------------------------
  console.log("\n--- HTTP surface ---");

  if (!baseUrl) {
    skip("GET /dashboard redirects to /login", "no --base-url; start `pnpm dev` and re-run");
    for (const route of sessionRoutes()) {
      skip(`unauthenticated ${route.method} ${route.path} → 401`, "no --base-url");
    }
  } else {
    const res = await fetch(`${baseUrl}/dashboard`, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    assert(
      "GET /dashboard redirects to /login",
      (res.status === 302 || res.status === 307) && location.includes("/login"),
      `${res.status} → ${location || "(no location)"}`,
    );

    for (const route of sessionRoutes()) {
      const r = await fetch(`${baseUrl}${route.path}`, { method: route.method, redirect: "manual" });
      assert(
        `unauthenticated ${route.method} ${route.path} → 401`,
        r.status === 401,
        `got ${r.status}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  const failed = results.filter((r) => !r.pass);
  if (skipped.length > 0) {
    console.log(`\n${skipped.length} check(s) SKIPPED:`);
    for (const s of skipped) {
      console.log(`  - ${s}`);
    }
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} test(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} checks passed.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("test-u1-auth FAILED:", message);
  process.exit(1);
});
