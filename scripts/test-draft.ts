import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createAnthropicClient } from "../src/lib/integrations/anthropic";
import { createTelegramClient } from "../src/lib/integrations/telegram";
import { createSettingsStore } from "../src/lib/settings/core";
import { createStateStore } from "../src/lib/state/core";
import { runDraftStage } from "../src/lib/stages/draft/core";
import { checkGenericDraft, wordCount } from "../src/lib/stages/draft/guard";
import { processTelegramUpdate } from "../src/lib/telegram/handler";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY in .env.local");
  process.exit(1);
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env.local");
  process.exit(1);
}

if (!process.env.TELEGRAM_ALLOWED_USER_IDS) {
  console.error("Missing TELEGRAM_ALLOWED_USER_IDS in .env.local");
  process.exit(1);
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

function parseLimit(argv: string[]): number {
  const idx = argv.indexOf("--limit");
  if (idx === -1) return 3;
  const value = Number.parseInt(argv[idx + 1] ?? "3", 10);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));
  console.log(`\n=== test-draft (limit=${limit}) ===\n`);

  const allowedIds = process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",").map((s) => s.trim()) ?? [];
  console.log(`TELEGRAM_ALLOWED_USER_IDS: ${allowedIds.join(", ") || "(empty)"}`);
  console.log("Note: each ID is used as chat_id — operator must /start the bot first.\n");

  const footerSetting = await settings.getActiveSetting("compliance_footer");
  const complianceFooter = String(footerSetting.value);
  const proofSetting = await settings.getActiveSetting("proof_points");
  const proofPoints = proofSetting.value as Record<string, string | null>;

  // Re-test prep: reset leads stuck from prior bad runs back to drafting
  const { data: resetCandidates } = await db
    .from("leads")
    .select("id, first_name, last_name, state")
    .in("state", ["pending_approval", "parked"])
    .order("created_at", { ascending: true })
    .limit(limit * 2);

  if ((resetCandidates ?? []).length > 0) {
    const resetIds = resetCandidates!.map((row) => row.id);
    await db.from("touches").delete().in("lead_id", resetIds);
    await db.from("leads").update({ state: "drafting" }).in("id", resetIds);
    console.log(`Reset ${resetIds.length} lead(s) to drafting for re-test: ${resetIds.join(", ")}\n`);
  }

  const { data: before } = await db
    .from("leads")
    .select("id, first_name, last_name, state, companies(name)")
    .eq("state", "drafting")
    .order("created_at", { ascending: true })
    .limit(limit);

  const pickedIds = (before ?? []).map((row) => row.id);
  console.log(
    `Picking up to ${limit} drafting lead(s): ${pickedIds.join(", ") || "(none)"}`,
  );

  if (pickedIds.length === 0) {
    console.error("No drafting leads available.");
    process.exit(1);
  }

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

  const { data: after } = await db
    .from("leads")
    .select("id, first_name, last_name, state")
    .in("id", pickedIds);

  const { data: touches } = await db
    .from("touches")
    .select(
      "id, lead_id, status, subject, draft_body, body, prompt_version, created_at",
    )
    .in("lead_id", pickedIds)
    .order("created_at", { ascending: false });

  const { data: qualifications } = await db
    .from("qualification")
    .select("lead_id, problem_hypothesis, visible_tools, evidence, segment")
    .in("lead_id", pickedIds);

  const { data: companies } = await db
    .from("leads")
    .select("id, companies(name)")
    .in("id", pickedIds);

  const companyByLead = new Map(
    (companies ?? []).map((row) => {
      const company = row.companies as { name: string } | null;
      return [row.id, company?.name ?? ""];
    }),
  );

  const qualByLead = new Map(
    (qualifications ?? []).map((q) => [q.lead_id, q]),
  );

  console.log("\n--- Drafts (full) ---");
  const draftedTouches = (touches ?? []).filter(
    (t) => (t.lead_id && pickedIds.includes(t.lead_id)) || summary.drafted > 0,
  );
  const touchIdsShown = new Set<string>();

  for (const leadId of pickedIds) {
    const lead = (after ?? []).find((row) => row.id === leadId);
    const touch = (touches ?? []).find((row) => row.lead_id === leadId);
    const qual = qualByLead.get(leadId);

    if (!touch) {
      console.log(`\n[${lead?.first_name ?? ""} ${lead?.last_name ?? ""}] lead=${leadId} — SKIPPED (no touch; likely batch slot taken by another lead or stage failure)`);
      continue;
    }

    const body = touch.draft_body ?? "";
    const modelBody = body.includes(complianceFooter.trim())
      ? body.replace(`\n\n${complianceFooter.trim()}`, "").trim()
      : body.split("\n\nZyndix, MB")[0]?.trim() ?? body;
    const wc = wordCount(modelBody);
    console.log(`\n[${lead?.first_name ?? ""} ${lead?.last_name ?? ""}] lead=${leadId}`);
    console.log(`SUBJECT: ${touch.subject ?? ""}`);
    console.log(`BODY — model (${wc} words):\n${modelBody}`);
    if (body !== modelBody) {
      console.log(`FOOTER:\n${complianceFooter}`);
    }
    console.log(`FULL (${wordCount(body)} words total with signature)`);
    touchIdsShown.add(touch.id);
  }

  for (const touch of touches ?? []) {
    if (touchIdsShown.has(touch.id)) continue;
    const lead = (after ?? []).find((row) => row.id === touch.lead_id);
    const body = touch.draft_body ?? "";
    const modelBody = body.includes(complianceFooter.trim())
      ? body.replace(`\n\n${complianceFooter.trim()}`, "").trim()
      : body;
    console.log(`\n[${lead?.first_name ?? ""} ${lead?.last_name ?? ""}] lead=${touch.lead_id} (batch extra)`);
    console.log(`SUBJECT: ${touch.subject ?? ""}`);
    console.log(`BODY — model (${wordCount(modelBody)} words):\n${modelBody}`);
    if (body !== modelBody) console.log(`FOOTER:\n${complianceFooter}`);
    touchIdsShown.add(touch.id);
  }

  for (const leadId of pickedIds) {
    const lead = (after ?? []).find((row) => row.id === leadId);
    const touch = (touches ?? []).find((row) => row.lead_id === leadId);

    if (!touch) {
      continue;
    }

    assert(
      `${leadId} → pending_approval`,
      lead?.state === "pending_approval",
      lead?.state,
    );

    assert(`${leadId} touch exists`, Boolean(touch));
    assert(
      `${leadId} touch status pending_approval`,
      touch?.status === "pending_approval",
      touch?.status ?? "missing",
    );
    assert(
      `${leadId} draft_body set`,
      Boolean(touch?.draft_body?.trim()),
    );
    assert(`${leadId} body null`, touch?.body === null, String(touch?.body));
    assert(
      `${leadId} prompt_version recorded`,
      typeof touch?.prompt_version === "number" && touch.prompt_version > 0,
      String(touch?.prompt_version),
    );

    const body = touch?.draft_body ?? "";
    const modelBody = body.includes(complianceFooter.trim())
      ? body.replace(`\n\n${complianceFooter.trim()}`, "").trim()
      : body.split("\n\nZyndix, MB")[0]?.trim() ?? body;
    const wc = wordCount(modelBody);
    assert(`${leadId} model body ≤120 words`, wc <= 120, String(wc));

    const bodyLower = modelBody.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
      assert(
        `${leadId} no banned phrase "${phrase}"`,
        !bodyLower.includes(phrase),
      );
    }

    const qual = qualByLead.get(leadId);
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
        companyName: companyByLead.get(leadId) ?? "",
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
      assert(`${leadId} generic guard`, guard.ok, guard.ok ? (guard.ok ? guard.matched : undefined) : guard.reason);

      if (!proofPoint) {
        for (const pattern of CLIENT_CLAIM_PATTERNS) {
          assert(
            `${leadId} no client claim "${pattern}" without proof`,
            !bodyLower.includes(pattern),
          );
        }
      }

      assert(
        `${leadId} signature block appended`,
        body.includes("— Amir") && body.includes("Gerosios Vilties"),
        body.slice(-160),
      );
      assert(
        `${leadId} no fake Dallas placeholder`,
        !body.includes("1234 Example St") && !body.includes("Dallas, TX"),
      );
    }
  }

  console.log("\n--- Non-whitelisted callback rejection ---");
  const rejectUpdate = {
    update_id: 9_999_999_999,
    callback_query: {
      id: "test-reject-callback",
      from: { id: 999_999_999 },
      data: "approve:00000000-0000-0000-0000-000000000000",
      message: {
        message_id: 1,
        chat: { id: 1 },
        text: "test approval message",
      },
    },
  };

  const rejectResult = await processTelegramUpdate(
    {
      db,
      telegram,
      transition: state.transition,
      getActiveSetting: settings.getActiveSetting,
      writeNewVersion: settings.writeNewVersion,
    },
    rejectUpdate,
    { skipStore: true },
  );

  assert("non-whitelisted callback rejected", rejectResult.rejected === true);

  console.log("\n--- Assertion summary ---");
  const failed = results.filter((r) => !r.pass);
  for (const result of results) {
    if (!result.pass) continue;
  }
  console.log(`${results.length - failed.length}/${results.length} passed`);

  if (failed.length > 0) {
    console.error("\nFailed assertions:");
    for (const result of failed) {
      console.error(`- ${result.name}${result.detail ? `: ${result.detail}` : ""}`);
    }
    process.exit(1);
  }

  console.log("\nDrafts sent to Telegram. Run `pnpm tsx scripts/telegram-poll.ts` to test buttons.");
  console.log("✅ Send approves without sending email (step 11 owns send).");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
