/**
 * scripts/test-draft.ts — step 10 DoD: writer + Telegram approval.
 *
 * SAFETY CONTRACT (this script previously violated all three):
 *   1. It creates its own synthetic company/lead/qualification fixtures and
 *      touches nothing else. It never selects, mutates or deletes a real
 *      prospect.
 *   2. Every lead state change goes through `lib/state.ts`. There is no
 *      direct write to `leads.state` anywhere in this file.
 *   3. Cleanup is scoped strictly to the ids this run created, and the run
 *      asserts that non-fixture row counts are identical before and after.
 *
 * `runDraftStage` picks leads by `state = 'drafting'` globally and cannot be
 * pointed at specific ids, so the run aborts if any non-fixture lead is
 * sitting in `drafting`.
 *
 * Cost: one Anthropic writer call per fixture (~$0.005, two if the generic
 * guard forces a retry) and two Telegram messages per fixture to the
 * operator's own chat ids. No prospect is contacted; no email is sent.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import { createAnthropicClient } from "../src/lib/integrations/anthropic";
import { createTelegramClient } from "../src/lib/integrations/telegram";
import { createSettingsStore } from "../src/lib/settings/core";
import { createStateStore } from "../src/lib/state/core";
import { runDraftStage } from "../src/lib/stages/draft/core";
import { checkGenericDraft, wordCount } from "../src/lib/stages/draft/guard";
import { processTelegramUpdate } from "../src/lib/telegram/handler";
import { approvalHash, buildApprovalSnapshot } from "../src/lib/sending/approval";
import type { DatabaseWithSending } from "../src/types/database-extensions";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
for (const required of [
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
]) {
  if (!process.env[required]) {
    console.error(`Missing ${required} in .env.local`);
    process.exit(1);
  }
}

const db = createServiceClient(url, key);
const state = createStateStore(db);
const settings = createSettingsStore(db);
const anthropic = createAnthropicClient();
const telegram = createTelegramClient();

const BANNED_PHRASES = [
  "ai automation",
  "automation solutions",
  "streamline your business",
  "leverage ai",
  "in today's fast-paced",
  "i hope this email finds you",
  "revolutionize",
] as const;

const CLIENT_CLAIM_PATTERNS = [
  "we work with",
  "a client of ours",
  "we helped",
  "one of our clients",
  "a broker we",
  "we wired",
  "after we",
] as const;

// `.example.com` is the fixture-domain convention scripts/purge-test-data.ts
// already sweeps, so an interrupted run leaves something recoverable.
const RUN_TAG = `draft-fixture-${Date.now()}`;
const FIXTURE_DOMAIN_SUFFIX = ".example.com";

type Fixture = { companyId: string; leadId: string; companyName: string };
type Counts = { leads: number; touches: number; leadEvents: number };

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

function parseLimit(argv: string[]): number {
  const idx = argv.indexOf("--limit");
  if (idx === -1) return 1;
  const value = Number.parseInt(argv[idx + 1] ?? "1", 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

async function countTable(table: "leads" | "touches" | "lead_events"): Promise<number> {
  const { count, error } = await db
    .from(table)
    .select("id", { count: "exact", head: true });
  if (error) {
    throw new Error(`count(${table}) failed: ${error.message}`);
  }
  return count ?? 0;
}

async function snapshotCounts(): Promise<Counts> {
  const [leads, touches, leadEvents] = await Promise.all([
    countTable("leads"),
    countTable("touches"),
    countTable("lead_events"),
  ]);
  return { leads, touches, leadEvents };
}

function formatCounts(c: Counts): string {
  return `leads=${c.leads} touches=${c.touches} lead_events=${c.leadEvents}`;
}

/**
 * Abort rather than run if a real lead is sitting in `drafting`. The stage
 * selects globally by state, so this is the only way to guarantee the run
 * touches nothing but its own fixtures.
 */
async function assertNoForeignDraftingLeads(): Promise<void> {
  const { data, error } = await db
    .from("leads")
    .select("id, companies(domain)")
    .eq("state", "drafting");

  if (error) {
    throw new Error(`drafting pre-check failed: ${error.message}`);
  }

  const foreign = (data ?? []).filter((row) => {
    const company = row.companies as { domain: string | null } | null;
    return !company?.domain?.endsWith(FIXTURE_DOMAIN_SUFFIX);
  });

  if (foreign.length > 0) {
    console.error(
      `\nABORT: ${foreign.length} non-fixture lead(s) are in state 'drafting': ` +
        `${foreign.map((r) => r.id).join(", ")}\n` +
        "runDraftStage picks by state globally, so running now would draft for real " +
        "prospects. Resolve those leads first.",
    );
    process.exit(1);
  }
}

async function seedFixture(index: number): Promise<Fixture> {
  const domain = `${RUN_TAG}-${index}${FIXTURE_DOMAIN_SUFFIX}`;
  const companyName = `Draft Fixture Realty ${index}`;

  const { data: company, error: companyError } = await db
    .from("companies")
    .insert({
      name: companyName,
      domain,
      segment: "us-realestate",
      country: "United States",
      city: "Austin",
      timezone: "America/Chicago",
      industry: "real estate",
      status: "qualified",
    })
    .select("id")
    .single();

  if (companyError || !company) {
    throw new Error(`fixture company insert failed: ${companyError?.message}`);
  }

  const { data: lead, error: leadError } = await db
    .from("leads")
    .insert({
      company_id: company.id,
      first_name: "Test",
      last_name: "Lead",
      title: "Managing Broker",
      email: `test.lead@${domain}`,
      email_status: "valid",
      email_verified_at: new Date().toISOString(),
      timezone: "America/Chicago",
      state: "sourced",
    })
    .select("id")
    .single();

  if (leadError || !lead) {
    throw new Error(`fixture lead insert failed: ${leadError?.message}`);
  }

  // Concrete, named evidence: the generic guard requires a real anchor
  // (company name, tool, number or proper noun) or it parks the draft.
  const { error: qualError } = await db.from("qualification").insert({
    lead_id: lead.id,
    fit_score: 72,
    segment: "us-realestate",
    problem_hypothesis:
      `${companyName} routes every website enquiry into a shared inbox and ` +
      "answers it by hand, so evening and weekend leads wait until the next " +
      "working morning before anyone replies.",
    evidence: [
      {
        observation:
          "The contact page posts a shared team address rather than a routed form, and the footer lists office hours only.",
        source: `https://${domain}/contact`,
        confidence: "medium",
      },
      {
        observation:
          "Follow Up Boss is embedded on the listings pages, but no scheduling or auto-response widget is present on any page crawled.",
        source: `https://${domain}/listings`,
        confidence: "high",
      },
    ],
    triggers: ["hiring a transaction coordinator"],
    visible_tools: ["Follow Up Boss"],
    recommended_angle:
      "Speed-to-lead on out-of-hours enquiries, framed around what their own contact page shows.",
    prompt_version: 4,
    model: "fixture",
  });

  if (qualError) {
    throw new Error(`fixture qualification insert failed: ${qualError.message}`);
  }

  // Every hop through lib/state.ts — never a direct leads.state write.
  const path: [string, string][] = [
    ["sourced", "enriching"],
    ["enriching", "qualifying"],
    ["qualifying", "qualified"],
    ["qualified", "verifying"],
    ["verifying", "drafting"],
  ];
  for (const [from, to] of path) {
    await state.transition(
      lead.id,
      from as never,
      to as never,
      to === "drafting" ? "verified" : "enriched",
      { stage: "test-draft fixture" },
    );
  }

  return { companyId: company.id, leadId: lead.id, companyName };
}

async function cleanupFixtures(fixtures: Fixture[]): Promise<void> {
  if (fixtures.length === 0) return;
  const leadIds = fixtures.map((f) => f.leadId);
  const companyIds = fixtures.map((f) => f.companyId);

  for (const table of [
    "touches",
    "lead_events",
    "qualification_history",
    "qualification",
    "enrichment_payloads",
  ] as const) {
    const { error } = await db.from(table).delete().in("lead_id", leadIds);
    if (error) throw new Error(`cleanup ${table} failed: ${error.message}`);
  }

  const { error: leadError } = await db.from("leads").delete().in("id", leadIds);
  if (leadError) throw new Error(`cleanup leads failed: ${leadError.message}`);

  const { error: companyError } = await db
    .from("companies")
    .delete()
    .in("id", companyIds);
  if (companyError) throw new Error(`cleanup companies failed: ${companyError.message}`);

  console.log(
    `\nCleanup: removed ${fixtures.length} fixture lead(s), company(ies) and all related rows.`,
  );
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));
  console.log(`\n=== test-draft (fixtures=${limit}, tag=${RUN_TAG}) ===\n`);

  const allowedIds =
    process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",").map((s) => s.trim()) ?? [];
  console.log(`TELEGRAM_ALLOWED_USER_IDS: ${allowedIds.join(", ") || "(empty)"}`);
  console.log("Note: each ID is used as chat_id — operator must /start the bot first.\n");

  await assertNoForeignDraftingLeads();

  const before = await snapshotCounts();
  console.log(`BEFORE  ${formatCounts(before)}\n`);

  const footerSetting = await settings.getActiveSetting("compliance_footer");
  const complianceFooter = String(footerSetting.value);
  const proofSetting = await settings.getActiveSetting("proof_points");
  const proofPoints = proofSetting.value as Record<string, string | null>;

  const fixtures: Fixture[] = [];
  try {
    for (let i = 1; i <= limit; i++) {
      fixtures.push(await seedFixture(i));
    }
    console.log(
      `Seeded ${fixtures.length} fixture lead(s) in 'drafting': ${fixtures
        .map((f) => f.leadId)
        .join(", ")}\n`,
    );

    const summary = await runDraftStage(
      {
        db,
        anthropic,
        telegram,
        getActiveSetting: settings.getActiveSetting,
        transition: state.transition,
      },
      { limit },
    );

    console.log("\n--- Draft stage summary ---");
    console.log(JSON.stringify(summary, null, 2));

    const fixtureLeadIds = fixtures.map((f) => f.leadId);

    assert(
      "stage picked only fixture leads",
      summary.leads_picked === fixtures.length,
      `leads_picked=${summary.leads_picked}, fixtures=${fixtures.length}`,
    );

    const { data: after } = await db
      .from("leads")
      .select("id, first_name, last_name, state")
      .in("id", fixtureLeadIds);

    const { data: touches } = await db
      .from("touches")
      .select("id, lead_id, status, subject, draft_body, body, prompt_version")
      .in("lead_id", fixtureLeadIds)
      .order("created_at", { ascending: false });

    const { data: qualifications } = await db
      .from("qualification")
      .select("lead_id, problem_hypothesis, visible_tools, evidence, segment")
      .in("lead_id", fixtureLeadIds);

    const qualByLead = new Map((qualifications ?? []).map((q) => [q.lead_id, q]));

    console.log("\n--- Drafts (full) ---");
    for (const fixture of fixtures) {
      const lead = (after ?? []).find((row) => row.id === fixture.leadId);
      const touch = (touches ?? []).find((row) => row.lead_id === fixture.leadId);

      if (!touch) {
        console.log(`\n[${fixture.companyName}] lead=${fixture.leadId} — NO TOUCH`);
        assert(`${fixture.leadId} touch exists`, false, `state=${lead?.state}`);
        continue;
      }

      const body = touch.draft_body ?? "";
      const modelBody = body.includes(complianceFooter.trim())
        ? body.replace(`\n\n${complianceFooter.trim()}`, "").trim()
        : body.split("\n\nZyndix, MB")[0]?.trim() ?? body;
      const wc = wordCount(modelBody);

      console.log(`\n[${fixture.companyName}] lead=${fixture.leadId}`);
      console.log(`SUBJECT: ${touch.subject ?? ""}`);
      console.log(`BODY — model (${wc} words):\n${modelBody}`);
      console.log(`FULL (${wordCount(body)} words total with signature)`);

      assert(`${fixture.leadId} → pending_approval`, lead?.state === "pending_approval", lead?.state);
      assert(`${fixture.leadId} touch exists`, true);
      assert(
        `${fixture.leadId} touch status pending_approval`,
        touch.status === "pending_approval",
        touch.status ?? "missing",
      );
      assert(`${fixture.leadId} draft_body set`, Boolean(touch.draft_body?.trim()));
      assert(`${fixture.leadId} body null`, touch.body === null, String(touch.body));
      assert(
        `${fixture.leadId} prompt_version recorded`,
        typeof touch.prompt_version === "number" && touch.prompt_version > 0,
        String(touch.prompt_version),
      );
      assert(`${fixture.leadId} model body ≤120 words`, wc <= 120, String(wc));

      const bodyLower = modelBody.toLowerCase();
      for (const phrase of BANNED_PHRASES) {
        assert(`${fixture.leadId} no banned phrase "${phrase}"`, !bodyLower.includes(phrase));
      }

      const qual = qualByLead.get(fixture.leadId);
      if (qual) {
        const tools = Array.isArray(qual.visible_tools)
          ? qual.visible_tools.filter((t): t is string => typeof t === "string")
          : [];
        const evidence = Array.isArray(qual.evidence)
          ? qual.evidence
              .filter(
                (item): item is { observation: string } =>
                  typeof item === "object" &&
                  item !== null &&
                  "observation" in item &&
                  typeof (item as { observation: unknown }).observation === "string",
              )
              .map((item) => ({ observation: item.observation }))
          : [];
        const segmentKey = qual.segment ?? "us-realestate";
        const proofPoint = proofPoints[segmentKey] ?? null;

        const guard = checkGenericDraft({
          body: modelBody,
          problemHypothesis: qual.problem_hypothesis,
          companyName: fixture.companyName,
          companyDomain: null,
          visibleTools: tools,
          evidence,
          proofPoint,
          numberSourceTexts: [
            qual.problem_hypothesis,
            ...evidence.map((e) => e.observation),
            proofPoint ?? "",
          ],
        });
        assert(
          `${fixture.leadId} generic guard`,
          guard.ok,
          guard.ok ? guard.matched : guard.reason,
        );

        if (!proofPoint) {
          for (const pattern of CLIENT_CLAIM_PATTERNS) {
            assert(
              `${fixture.leadId} no client claim "${pattern}" without proof`,
              !bodyLower.includes(pattern),
            );
          }
        }

        assert(
          `${fixture.leadId} signature block appended`,
          body.includes("— Amir") && body.includes("Gerosios Vilties"),
          body.slice(-160),
        );
        assert(
          `${fixture.leadId} no fake Dallas placeholder`,
          !body.includes("1234 Example St") && !body.includes("Dallas, TX"),
        );
      }
    }

    // --- Telegram ✅ path, driven against the fixture touch -----------------
    // `message.text` is deliberately omitted so handleApprove takes its
    // sendMessage branch instead of editMessage, which would need a real
    // Telegram message_id that sendApproval does not return.
    console.log("\n--- Telegram approve path (fixture touch) ---");
    const firstTouch = (touches ?? []).find((t) => t.lead_id === fixtures[0]?.leadId);
    const approverId = Number.parseInt(allowedIds[0] ?? "", 10);

    if (firstTouch && Number.isFinite(approverId)) {
      // `answerCallback` acknowledges a real button press back to Telegram.
      // No button was pressed here, so the synthetic query id is rejected by
      // the API. Stub that one method and leave everything else live: the DB
      // writes, the state transition and the operator message are all real.
      const approveTelegram = {
        ...telegram,
        answerCallback: async () => {},
      };

      await processTelegramUpdate(
        {
          db,
          telegram: approveTelegram,
          transition: state.transition,
          getActiveSetting: settings.getActiveSetting,
          writeNewVersion: settings.writeNewVersion,
        },
        {
          update_id: 9_999_999_998,
          callback_query: {
            id: "test-approve-callback",
            from: { id: approverId },
            data: `approve:${firstTouch.id}`,
            message: { message_id: 1, chat: { id: approverId } },
          },
        },
        { skipStore: true },
      );

      const { data: approvedTouch } = await db
        .from("touches")
        .select("status, body, draft_body")
        .eq("id", firstTouch.id)
        .single();
      const approvedLead = await state.getLead(fixtures[0]!.leadId);

      assert(
        "approve → touch status approved",
        approvedTouch?.status === "approved",
        approvedTouch?.status ?? "missing",
      );
      assert(
        "approve → body copied from draft_body",
        Boolean(approvedTouch?.body) && approvedTouch?.body === approvedTouch?.draft_body,
      );
      assert(
        "approve → lead state approved",
        approvedLead.state === "approved",
        approvedLead.state,
      );

      // U5: the approval is bound to the exact content and recipient.
      const { data: binding } = await (db as unknown as SupabaseClient<DatabaseWithSending>)
        .from("touches")
        .select("id, step_no, channel, subject, body, prompt_version, approval_hash, approved_by, approved_at")
        .eq("id", firstTouch.id)
        .single();
      const expectedHash = binding
        ? approvalHash(buildApprovalSnapshot(binding, { id: approvedLead.id, email: approvedLead.email }))
        : null;
      assert(
        "approve → approval_hash binds subject/body/recipient (U5)",
        Boolean(binding?.approval_hash) && binding?.approval_hash === expectedHash,
      );
      assert(
        "approve → approved_by and approved_at recorded (U5)",
        binding?.approved_by === `telegram:${approverId}` && Boolean(binding?.approved_at),
        binding?.approved_by ?? "missing",
      );
    } else {
      console.log("SKIP: no fixture touch or no numeric allowed user id.");
    }

    // --- Non-whitelisted callback rejection --------------------------------
    console.log("\n--- Non-whitelisted callback rejection ---");
    const rejectResult = await processTelegramUpdate(
      {
        db,
        telegram,
        transition: state.transition,
        getActiveSetting: settings.getActiveSetting,
        writeNewVersion: settings.writeNewVersion,
      },
      {
        update_id: 9_999_999_999,
        callback_query: {
          id: "test-reject-callback",
          from: { id: 999_999_999 },
          data: "approve:00000000-0000-0000-0000-000000000000",
          message: { message_id: 1, chat: { id: 1 }, text: "test approval message" },
        },
      },
      { skipStore: true },
    );

    assert("non-whitelisted callback rejected", rejectResult.rejected === true);
  } finally {
    await cleanupFixtures(fixtures);
  }

  // --- Non-destructiveness proof -----------------------------------------
  const afterCounts = await snapshotCounts();
  console.log(`\nBEFORE  ${formatCounts(before)}`);
  console.log(`AFTER   ${formatCounts(afterCounts)}`);

  assert(
    "leads count unchanged",
    afterCounts.leads === before.leads,
    `${before.leads} → ${afterCounts.leads}`,
  );
  assert(
    "touches count unchanged",
    afterCounts.touches === before.touches,
    `${before.touches} → ${afterCounts.touches}`,
  );
  assert(
    "lead_events count unchanged",
    afterCounts.leadEvents === before.leadEvents,
    `${before.leadEvents} → ${afterCounts.leadEvents}`,
  );

  console.log("\n--- Assertion summary ---");
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} passed`);

  if (failed.length > 0) {
    console.error("\nFailed assertions:");
    for (const result of failed) {
      console.error(`- ${result.name}${result.detail ? `: ${result.detail}` : ""}`);
    }
    process.exit(1);
  }

  console.log("\n✅ Step 10 approve path verified. No email sent — send is a later unit.");
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
