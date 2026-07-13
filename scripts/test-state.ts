import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import {
  createStateStore,
  IllegalTransitionError,
  TransitionError,
} from "../src/lib/state/core";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const state = createStateStore(db);

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

function sameInstant(
  actual: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (actual == null || expected == null) {
    return actual === expected;
  }
  return new Date(actual).getTime() === new Date(expected).getTime();
}

const TEST_DOMAIN = `state-test-${Date.now()}.example.com`;

async function countLeadEvents(leadId: string): Promise<number> {
  const { count, error } = await db
    .from("lead_events")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId);

  if (error) {
    throw new Error(`countLeadEvents failed: ${error.message}`);
  }
  return count ?? 0;
}

async function cleanupTestRows(leadId: string, companyId: string): Promise<void> {
  const { error: deleteEventsError } = await db
    .from("lead_events")
    .delete()
    .eq("lead_id", leadId);

  if (deleteEventsError) {
    throw new Error(`Cleanup lead_events failed: ${deleteEventsError.message}`);
  }

  const { error: deleteQualHistoryError } = await db
    .from("qualification_history")
    .delete()
    .eq("lead_id", leadId);

  if (deleteQualHistoryError) {
    throw new Error(
      `Cleanup qualification_history failed: ${deleteQualHistoryError.message}`,
    );
  }

  const { error: deleteQualError } = await db
    .from("qualification")
    .delete()
    .eq("lead_id", leadId);

  if (deleteQualError) {
    throw new Error(`Cleanup qualification failed: ${deleteQualError.message}`);
  }

  const { error: deletePayloadsError } = await db
    .from("enrichment_payloads")
    .delete()
    .eq("lead_id", leadId);

  if (deletePayloadsError) {
    throw new Error(
      `Cleanup enrichment_payloads failed: ${deletePayloadsError.message}`,
    );
  }

  const { error: deleteLeadError } = await db.from("leads").delete().eq("id", leadId);
  if (deleteLeadError) {
    throw new Error(`Cleanup lead failed: ${deleteLeadError.message}`);
  }

  const { error: deleteCompanyError } = await db
    .from("companies")
    .delete()
    .eq("id", companyId);

  if (deleteCompanyError) {
    throw new Error(`Cleanup company failed: ${deleteCompanyError.message}`);
  }
}

async function main(): Promise<void> {
  let leadId: string | null = null;
  let companyId: string | null = null;

  try {
  const { data: company, error: companyError } = await db
    .from("companies")
    .insert({ name: "State Test Co", domain: TEST_DOMAIN })
    .select("id")
    .single();

  if (companyError || !company) {
    throw new Error(`Failed to create company: ${companyError?.message}`);
  }
  companyId = company.id;

  const { data: lead, error: leadError } = await db
    .from("leads")
    .insert({
      company_id: company.id,
      first_name: "Test",
      last_name: "Lead",
      email: `test@${TEST_DOMAIN}`,
      state: "sourced",
    })
    .select("id, state")
    .single();

  if (leadError || !lead) {
    throw new Error(`Failed to create lead: ${leadError?.message}`);
  }

  leadId = lead.id;
  let eventCount = await countLeadEvents(leadId);

  // Legal path: sourced → enriching → qualifying
  const afterEnriching = await state.transition(
    leadId,
    "sourced",
    "enriching",
    "enriched",
    { stage: "test" },
  );
  assert(
    "legal hop sourced → enriching updates state",
    afterEnriching.state === "enriching",
    `state=${afterEnriching.state}`,
  );

  eventCount += 1;
  const { count: eventsAfterHop1 } = await db
    .from("lead_events")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("event", "enriched");

  assert(
    "sourced → enriching wrote one lead_events row with from/to",
    (eventsAfterHop1 ?? 0) === 1,
    `count=${eventsAfterHop1}`,
  );

  const { data: hop1Event } = await db
    .from("lead_events")
    .select("detail")
    .eq("lead_id", leadId)
    .eq("event", "enriched")
    .single();

  const hop1Detail = hop1Event?.detail as Record<string, unknown> | null;
  assert(
    "enriched event detail contains from/to",
    hop1Detail?.from === "sourced" && hop1Detail?.to === "enriching",
  );

  const afterQualifying = await state.transition(
    leadId,
    "enriching",
    "qualifying",
    "enriched",
    { stage: "test", note: "ready to qualify" },
  );
  assert(
    "legal hop enriching → qualifying updates state",
    afterQualifying.state === "qualifying",
    `state=${afterQualifying.state}`,
  );

  eventCount += 1;
  assert(
    "total lead_events matches successful transitions",
    (await countLeadEvents(leadId)) === eventCount,
    `expected=${eventCount}`,
  );

  // Illegal jump: qualifying → sent
  const stateBeforeIllegal = (await state.getLead(leadId)).state;
  const eventsBeforeIllegal = await countLeadEvents(leadId);

  let illegalThrew = false;
  try {
    await state.transition(leadId, "qualifying", "sent", "sent");
  } catch (error) {
    illegalThrew = error instanceof IllegalTransitionError;
  }

  const stateAfterIllegal = (await state.getLead(leadId)).state;
  const eventsAfterIllegal = await countLeadEvents(leadId);

  assert("illegal qualifying → sent throws IllegalTransitionError", illegalThrew);
  assert(
    "illegal jump leaves leads.state unchanged",
    stateAfterIllegal === stateBeforeIllegal,
    `${stateBeforeIllegal} vs ${stateAfterIllegal}`,
  );
  assert(
    "illegal jump writes no lead_events row",
    eventsAfterIllegal === eventsBeforeIllegal,
    `${eventsBeforeIllegal} vs ${eventsAfterIllegal}`,
  );

  // Stale transition: caller expects sourced but lead is qualifying
  let staleThrew = false;
  let staleMessage = "";
  try {
    await state.transition(leadId, "sourced", "enriching", "enriched");
  } catch (error) {
    staleThrew = error instanceof TransitionError;
    staleMessage = error instanceof Error ? error.message : String(error);
  }

  assert(
    "stale transition throws TransitionError",
    staleThrew && staleMessage.includes("stale transition"),
    staleMessage,
  );

  // next_action_at when provided
  const nextAt = new Date(Date.now() + 86_400_000).toISOString();
  const afterQualified = await state.transition(
    leadId,
    "qualifying",
    "qualified",
    "qualified",
    { test: true },
    nextAt,
  );
  assert(
    "next_action_at set when passed",
    sameInstant(afterQualified.next_action_at, nextAt),
    `${afterQualified.next_action_at} vs ${nextAt}`,
  );

  // next_action_at cleared when null explicitly on a hop that allows it — use parked
  const afterParked = await state.transition(
    leadId,
    "qualified",
    "parked",
    "parked",
    { reason: "test" },
    null,
  );
  assert(
    "next_action_at null when not passed",
    afterParked.next_action_at === null,
    String(afterParked.next_action_at),
  );
  } finally {
    if (leadId && companyId) {
      await cleanupTestRows(leadId, companyId);
      console.log("Cleanup: removed test lead, company, and related rows.");
    }
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} test(s) failed.`);
    process.exit(1);
  }

  console.log(`\nAll ${results.length} checks passed.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("test-state FAILED:", message);
  process.exit(1);
});
