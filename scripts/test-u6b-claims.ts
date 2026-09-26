/**
 * scripts/test-u6b-claims.ts — 09 §U6b DoD (Session 15): the claim guard
 * through the real draft stage and the real Telegram approval handler.
 *
 * SAFETY CONTRACT
 *   - Synthetic fixtures only (`*.example.com` companies, tagged). The draft
 *     stage is scoped to fixture lead ids; no real prospect is selected.
 *   - Lead states move only through lib/state.
 *   - Mocked Anthropic and Telegram. A fetch guard fails any network call
 *     other than Supabase. Zero spend, nothing sent.
 *   - Cleanup is scoped to the ids this run created, and the run asserts the
 *     row counts are identical before and after.
 *
 * evidence_policy and cta_variants are pinned in-process (v1 / the approved
 * line) so the DoD does not depend on which settings version is active; the
 * other settings are read live.
 *
 * Session 19 (09 §U6c): the draft stage writes a 3-step sequence. The mocked
 * writer wraps each U6b draft as step 1 of the v10 shape plus a clean step 2
 * (`v10()`); email_sequence / followup_templates are pinned in-process too.
 * The U6b assertions are unchanged; only touch counts (3 per draft) and the
 * approval's sequence snapshot differ. Sequence cases: test-u6c-sequence.ts.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import type { AnthropicClient } from "../src/lib/integrations/anthropic";
import type { TelegramClient } from "../src/lib/integrations/telegram";
import { formatSequenceApprovalMessages } from "../src/lib/integrations/telegram-approval";
import { buildSequenceApprovalSnapshot, sequenceApprovalHash, type EmailSequence } from "../src/lib/sending/sequence-approval";
import { createSettingsStore } from "../src/lib/settings/core";
import type { ClaimReason } from "../src/lib/stages/draft/claims";
import { runDraftStage } from "../src/lib/stages/draft/core";
import { createStateStore } from "../src/lib/state/core";
import { processTelegramUpdate } from "../src/lib/telegram/handler";
import type { Claim } from "../src/lib/validation/llm";
import type { Database, Json } from "../src/types/database";
import type { DatabaseWithSending } from "../src/types/database-extensions";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const raw = createServiceClient(url, key);
const db = raw as SupabaseClient<Database>;
const sendDb = raw as unknown as SupabaseClient<DatabaseWithSending>;
const state = createStateStore(db);
const settings = createSettingsStore(db);

// A synthetic approver: the handler reads the whitelist from env at call time.
const APPROVER = 910_000_001;
process.env.TELEGRAM_ALLOWED_USER_IDS = String(APPROVER);

const APPROVED = "Happy to write up what I'd change, if that's useful.";
const TAG = `u6b-fixture-${Date.now()}`;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type TestResult = { name: string; pass: boolean; detail?: string };
const results: TestResult[] = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const network: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = String(input instanceof Request ? input.url : input);
  if (target.startsWith(url)) return realFetch(input, init);
  network.push(target);
  throw new Error(`unexpected network call: ${target}`);
}) as typeof fetch;

const SEQUENCE: EmailSequence = {
  steps: [
    { step_no: 1, delay: 0, delay_unit: "days", source: "writer" },
    { step_no: 2, delay: 7, delay_unit: "days", source: "writer" },
    { step_no: 3, delay: 7, delay_unit: "days", source: "template" },
  ],
};
const HONEST_CLOSE =
  "Hi {first_name},\n\nI haven't heard back, so I'll assume now isn't the right time and won't follow up again.\n\nIf it becomes a priority later, just reply to this email.";

async function getActiveSetting(k: string): Promise<{ version: number; value: unknown }> {
  if (k === "evidence_policy") return { version: 1, value: { max_age_days: 30 } };
  if (k === "email_sequence") return { version: 1, value: SEQUENCE };
  if (k === "followup_templates") return { version: 1, value: { templates: [{ step_no: 3, id: "honest_close", body: HONEST_CLOSE }] } };
  if (k === "cta_variants") {
    return {
      version: 3,
      value: {
        variants: [
          { id: "link", active: false, text: "inactive" },
          { id: "reply", active: true, text: `end with exactly: "${APPROVED}"`, approved_lines: [APPROVED] },
        ],
      },
    };
  }
  return settings.getActiveSetting(k as never);
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type WriterOut = { subject: string; body: string; claims: Claim[] } | Record<string, unknown>;
const scripts = new Map<string, WriterOut[]>(); // company name → outputs per call
const calls = new Map<string, number>();

const anthropic = {
  async complete(params: { user: string }) {
    const name = params.user.match(/"company_name":\s*"([^"]+)"/)?.[1] ?? "?";
    const n = calls.get(name) ?? 0;
    calls.set(name, n + 1);
    const outs = scripts.get(name) ?? [];
    const out = outs[Math.min(n, outs.length - 1)] ?? {};
    return { text: JSON.stringify(v10(out)), model: "mock", inputTokens: 1, outputTokens: 1, estCostUsd: 0 };
  },
} as unknown as AnthropicClient;

const tg = { cards: [] as string[], messages: [] as string[], alerts: [] as string[] };
const telegram = {
  async sendSequenceApproval(...args: Parameters<typeof formatSequenceApprovalMessages>) {
    tg.cards.push(formatSequenceApprovalMessages(...args).join("\n"));
    return { sent: 1, failed: [] };
  },
  async sendMessage(_chat: number, text: string) {
    tg.messages.push(text);
    return tg.messages.length;
  },
  async editMessage(_chat: number, _id: number, text: string) {
    tg.messages.push(text);
  },
  async answerCallback() {},
  async sendAlert(text: string) {
    tg.alerts.push(text);
  },
} as unknown as TelegramClient;

const handlerDeps = {
  db,
  telegram,
  transition: state.transition,
  getActiveSetting,
  writeNewVersion: settings.writeNewVersion,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Evidence = { source: string; observation: string };
type FixtureSpec = { evidence?: Evidence[]; siteText?: string; tech?: Record<string, unknown>; fetchedDaysAgo?: number };
type Fixture = { leadId: string; companyId: string; name: string };
const created: Fixture[] = [];

const BASE_EVIDENCE: Evidence[] = [
  { source: "website", observation: "Contact page lists a shared team inbox and one office phone number." },
  { source: "website", observation: "'Serving Houston and Katy since 2004' appears in the homepage header." },
  // 09 §U6c S20: step 2 must cite an item step 1 does not (step2_repeats_step1).
  { source: "website", observation: "The contact page offers two ways in: the office phone and the shared team inbox." },
];
const BASE_SITE = "Home\nServing Houston and Katy since 2004\nContact: team inbox, office phone";

async function fixture(label: string, spec: FixtureSpec = {}): Promise<Fixture> {
  const idx = created.length + 1;
  const name = `U6B Fixture Realty ${idx}`;
  const domain = `${TAG}-${idx}.example.com`;
  const { data: company, error: ce } = await db
    .from("companies")
    .insert({ name, domain, segment: "us-realestate", country: "United States", timezone: "America/Chicago", status: "qualified" })
    .select("id")
    .single();
  if (ce || !company) throw new Error(`company: ${ce?.message}`);
  const { data: lead, error: le } = await db
    .from("leads")
    .insert({
      company_id: company.id,
      first_name: "Pat",
      last_name: "Fixture",
      title: "Broker",
      email: `pat@${domain}`,
      email_status: "valid",
      email_verified_at: new Date().toISOString(),
      timezone: "America/Chicago",
      state: "sourced",
    })
    .select("id")
    .single();
  if (le || !lead) throw new Error(`lead: ${le?.message}`);
  const f = { leadId: lead.id, companyId: company.id, name };
  created.push(f);

  const { error: qe } = await db.from("qualification").insert({
    lead_id: lead.id,
    fit_score: 70,
    segment: "us-realestate",
    problem_hypothesis: `${name} answers every enquiry by hand from one shared team inbox.`,
    evidence: (spec.evidence ?? BASE_EVIDENCE) as unknown as Json,
    triggers: [],
    visible_tools: [],
    recommended_angle: "speed-to-lead",
    prompt_version: 1,
    model: "fixture",
  });
  if (qe) throw new Error(`qualification: ${qe.message}`);

  const fetchedAt = new Date(Date.now() - (spec.fetchedDaysAgo ?? 1) * DAY).toISOString();
  const { error: ee } = await db.from("enrichment_payloads").insert([
    {
      company_id: company.id,
      lead_id: lead.id,
      source: "apify_site",
      fetched_at: fetchedAt,
      payload: [{ url: `https://${domain}/`, text: spec.siteText ?? BASE_SITE }] as unknown as Json,
    },
    {
      company_id: company.id,
      lead_id: lead.id,
      source: "apify_tech",
      fetched_at: fetchedAt,
      payload: { url: `https://${domain}`, signals: spec.tech ?? { hasChatWidget: false } } as unknown as Json,
    },
  ]);
  if (ee) throw new Error(`enrichment: ${ee.message}`);

  for (const [from, to] of [
    ["sourced", "enriching"],
    ["enriching", "qualifying"],
    ["qualifying", "qualified"],
    ["qualified", "verifying"],
    ["verifying", "drafting"],
  ] as const) {
    await state.transition(lead.id, from, to, to === "drafting" ? "verified" : "enriched", { stage: `u6b fixture: ${label}` });
  }
  return f;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

const SUBJECT = "Houston and Katy enquiries";
const S_FACT = "you have been serving Houston and Katy since 2004";
const S_INBOX = "every enquiry goes to one shared team inbox";
const CLEAN_MIDDLE = "The first person to check it decides how fast a buyer hears back.";

function draft(middle = CLEAN_MIDDLE, extraClaims: Claim[] = [], offer = APPROVED): WriterOut {
  return {
    subject: SUBJECT,
    body: `Hi Pat,\n\nYour site says ${S_FACT}, and ${S_INBOX}. ${middle}\n\n${offer}`,
    claims: [
      { span: SUBJECT, kind: "inference", evidence_ids: ["E2"] },
      { span: S_FACT, kind: "prospect_fact", evidence_ids: ["E2"] },
      { span: S_INBOX, kind: "inference", evidence_ids: ["E1"] },
      { span: offer, kind: "offer", evidence_ids: [] },
      ...extraClaims,
    ],
  };
}

// A clean step 2 (09 §U6c): a new angle citing E2 + E3 (E3 is new to step 2, S20), anchored on "Houston".
const STEP2_SPAN = "for a Houston and Katy team, the office phone and the shared team inbox are the only two ways in";
const STEP2 = {
  step_no: 2,
  body: `Hi Pat,\n\nOne more thought: ${STEP2_SPAN}. The first person to pick up owns the reply.`,
  claims: [{ span: STEP2_SPAN, kind: "inference", evidence_ids: ["E2", "E3"] }],
};

/**
 * Wraps a v9-shaped U6b draft as step 1 of the v10 output, plus a clean step 2
 * (the default one, or the draft's own `step2` when its evidence differs).
 */
function v10(out: WriterOut): unknown {
  const o = out as { subject?: unknown; body?: unknown; claims?: unknown; step2?: unknown };
  if (!("body" in o)) return out;
  return { steps: [{ step_no: 1, subject: o.subject, body: o.body, claims: o.claims }, o.step2 ?? STEP2] };
}

async function runDraft(f: Fixture) {
  return runDraftStage(
    { db, anthropic, telegram, getActiveSetting, transition: state.transition },
    { limit: 1, leadIds: [f.leadId] },
  );
}

async function leadState(id: string): Promise<string> {
  return (await state.getLead(id)).state;
}

async function touchesFor(leadId: string) {
  const { data } = await sendDb.from("touches").select("*").eq("lead_id", leadId).order("step_no");
  return data ?? [];
}

async function holdEvent(leadId: string) {
  const { data } = await db.from("lead_events").select("detail").eq("lead_id", leadId).eq("event", "claim_guard_hold").maybeSingle();
  return data?.detail as { violations?: { reason: string; detail: string; token?: string }[] } | undefined;
}

/** A held case: 0 touches, manual_hold, the named reason, exactly 2 writer calls, one alert. */
async function expectHold(label: string, f: Fixture, reason: ClaimReason, detailMatch?: RegExp): Promise<void> {
  const alertsBefore = tg.alerts.length;
  const summary = await runDraft(f);
  const touches = await touchesFor(f.leadId);
  const hold = await holdEvent(f.leadId);
  const reasons = (hold?.violations ?? []).map((v) => v.reason);
  assert(`${label}: zero pending_approval touches`, touches.filter((t) => t.status === "pending_approval").length === 0 && touches.length === 0, `touches=${touches.length}`);
  assert(`${label}: lead manual_hold`, (await leadState(f.leadId)) === "manual_hold");
  assert(`${label}: claim_guard_hold names ${reason}`, reasons.includes(reason), reasons.join(","));
  if (detailMatch) {
    assert(`${label}: detail matches ${detailMatch}`, (hold?.violations ?? []).some((v) => v.reason === reason && detailMatch.test(v.detail)));
  }
  assert(`${label}: one revision retry (2 writer calls)`, calls.get(f.name) === 2, String(calls.get(f.name)));
  assert(`${label}: operator alerted once`, tg.alerts.length === alertsBefore + 1 && summary.claim_held === 1);
}

async function expectPending(label: string, f: Fixture, writerCalls = 1) {
  await runDraft(f);
  const touches = await touchesFor(f.leadId);
  const t = touches[0];
  assert(`${label}: lead pending_approval`, (await leadState(f.leadId)) === "pending_approval");
  assert(
    `${label}: 3 pending touches (steps 1–3), each with a claim ledger`,
    touches.length === 3 &&
      touches.map((x) => x.step_no).join() === "1,2,3" &&
      touches.every((x) => x.status === "pending_approval" && Array.isArray(x.claim_ledger)),
  );
  assert(`${label}: writer calls = ${writerCalls}`, calls.get(f.name) === writerCalls, String(calls.get(f.name)));
  return t!;
}

function callback(data: string, updateId: number) {
  return processTelegramUpdate(
    handlerDeps,
    { update_id: updateId, callback_query: { id: `cb-${updateId}`, from: { id: APPROVER }, data, message: { message_id: 1, chat: { id: APPROVER } } } },
    { skipStore: true },
  );
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

const COUNTED = ["companies", "leads", "touches", "lead_events", "qualification", "enrichment_payloads"] as const;
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of COUNTED) {
    const { count, error } = await db.from(t).select("id", { count: "exact", head: true });
    if (error) throw new Error(`count ${t}: ${error.message}`);
    out[t] = count ?? 0;
  }
  return out;
}

async function cleanup(): Promise<void> {
  const leadIds = created.map((f) => f.leadId);
  const companyIds = created.map((f) => f.companyId);
  if (leadIds.length === 0) return;
  for (const t of ["touches", "lead_events", "qualification_history", "qualification", "enrichment_payloads"] as const) {
    const { error } = await db.from(t).delete().in("lead_id", leadIds);
    if (error) throw new Error(`cleanup ${t}: ${error.message}`);
  }
  const { error: le } = await db.from("leads").delete().in("id", leadIds);
  if (le) throw new Error(`cleanup leads: ${le.message}`);
  const { error: ce } = await db.from("companies").delete().in("id", companyIds);
  if (ce) throw new Error(`cleanup companies: ${ce.message}`);
  console.log(`\nCleanup: removed ${leadIds.length} fixture leads and companies and their rows.`);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { data: col, error: colError } = await sendDb.from("touches").select("claim_ledger").limit(1);
  if (colError) {
    console.error(`touches.claim_ledger is not readable (${colError.message}). Apply supabase/migrations/0009c_claim_ledger.sql first.`);
    process.exit(1);
  }
  void col;

  const before = await counts();
  console.log(`BEFORE ${JSON.stringify(before)}\n`);

  try {
    console.log("--- DoD 1: invented timing ---");
    let f = await fixture("timing");
    scripts.set(f.name, [draft("A buyer who writes at 9pm on a Saturday hears back on Monday.")]);
    await expectHold("DoD 1", f, "invented_timing");

    console.log("\n--- DoD 2: unbacked asset ---");
    f = await fixture("asset");
    scripts.set(f.name, [draft("I've mapped out a few fixes for that inbox.")]);
    await expectHold("DoD 2", f, "unbacked_asset_claim");

    console.log("\n--- DoD 3: unapproved offer ---");
    f = await fixture("offer");
    scripts.set(f.name, [draft(CLEAN_MIDDLE, [], "I can set up an instant reply for you.")]);
    await expectHold("DoD 3", f, "unapproved_offer");

    console.log("\n--- DoD 4: stale evidence (31 days) / fresh (29 days) ---");
    f = await fixture("stale-31", { fetchedDaysAgo: 31 });
    scripts.set(f.name, [draft()]);
    await expectHold("DoD 4 (31d)", f, "stale_evidence");
    // Session 19 (09 §U6c per-step freshness): at 29 days step 1 still passes,
    // but step 2 goes out 7 days later (29 + 7 > 30), so the sequence holds on
    // step 2 only. A 22-day fixture passes whole (test-u6c-sequence.ts).
    f = await fixture("fresh-29", { fetchedDaysAgo: 29 });
    scripts.set(f.name, [draft()]);
    await expectHold("DoD 4 (29d)", f, "stale_evidence", /^step 2: 29d \+ 7d > 30d/);
    const fresh29 = (await holdEvent(f.leadId)) as { steps?: { step: number }[] } | undefined;
    assert("DoD 4 (29d): step 1 passes; only step 2 is stale", fresh29?.steps?.map((x) => x.step).join() === "2", JSON.stringify(fresh29?.steps?.map((x) => x.step)));

    console.log("\n--- DoD 5: REBG contradiction ---");
    f = await fixture("rebg", {
      evidence: [
        ...BASE_EVIDENCE,
        { source: "website", observation: "Broker page explicitly says 'Call or Email anytime' and 'Better yet try the chat icon' — manual, owner-handled response." },
      ],
      siteText: `${BASE_SITE}\nCall or Email anytime. Better yet try the chat icon`,
      tech: { hasChatWidget: false },
    });
    scripts.set(f.name, [
      draft("There is no chat or instant acknowledgment when a buyer writes in.", [
        { span: "There is no chat or instant acknowledgment when a buyer writes in", kind: "inference", evidence_ids: ["E1"] },
      ]),
    ]);
    await expectHold("DoD 5", f, "contradicted_evidence");

    console.log("\n--- DoD 6: invented place ---");
    f = await fixture("beaumont");
    scripts.set(f.name, [draft("Buyers in Beaumont get the same inbox.")]);
    await expectHold("DoD 6", f, "uncovered_fact");

    // The Gottesman pattern from the audit: the qualifier's paraphrase has
    // $1.2M, the crawled page does not. (A figure in no evidence at all is
    // caught earlier by the generic number guard and parked — unit-tested.)
    console.log("\n--- DoD 7: $1.2M in the evidence paraphrase but not on the page ---");
    f = await fixture("money", { evidence: [...BASE_EVIDENCE, { source: "website", observation: "Listings page shows properties from $1.2M to $6.9M." }] });
    scripts.set(f.name, [draft("I noticed your listings start at $1.2M.", [{ span: "your listings start at $1.2M", kind: "prospect_fact", evidence_ids: ["E4"] }])]);
    await expectHold("DoD 7", f, "unsupported_prospect_fact", /^not in source page: "\$1\.2M"/);

    console.log("\n--- DoD 8: failed-crawl evidence cited ---");
    f = await fixture("failed-crawl", { evidence: [...BASE_EVIDENCE, { source: "website", observation: "Tech stack fetch failed — no CRM tooling confirmed." }] });
    scripts.set(f.name, [draft("Nothing routes an enquiry to the right agent.", [{ span: "Nothing routes an enquiry to the right agent", kind: "inference", evidence_ids: ["E4"] }])]);
    await expectHold("DoD 8", f, "failed_crawl_evidence");

    console.log("\n--- Operator addition: Steffen (quote not on the source page) ---");
    const steffenEvidence = [
      { source: "website", observation: "Auction Gallery page describes consignment intake ('contact us to schedule a preview', flat-rate commission pitch)." },
      // S20: step 2 cites an item step 1 does not.
      { source: "website", observation: "Auction Gallery page pitches a flat-rate commission to sellers." },
    ];
    const steffenPage = "Auction Gallery\nFlat-rate commission. Consign with us.";
    const steffenDraft = (span: string): WriterOut => ({
      subject: "consignment intake",
      body: `Hi Pat,\n\nI noticed ${span}, so every consignment starts with a manual back-and-forth.\n\n${APPROVED}`,
      claims: [
        { span, kind: "prospect_fact", evidence_ids: ["E1"] },
        { span: "every consignment starts with a manual back-and-forth", kind: "inference", evidence_ids: ["E1"] },
        { span: APPROVED, kind: "offer", evidence_ids: [] },
      ],
      // Step 2 grounded in Steffen's own second evidence item.
      step2: {
        step_no: 2,
        body: "Hi Pat,\n\nOne more thought: the Auction Gallery page pitches a flat-rate commission to sellers.",
        claims: [{ span: "the Auction Gallery page pitches a flat-rate commission to sellers", kind: "inference", evidence_ids: ["E2"] }],
      },
    });
    const quoted = 'your gallery page asks sellers to "contact us to schedule a preview"';
    const unquoted = "your gallery page asks sellers to contact us to schedule a preview";
    f = await fixture("steffen-quoted", { evidence: steffenEvidence, siteText: steffenPage });
    scripts.set(f.name, [steffenDraft(quoted)]);
    await expectHold("Steffen quoted", f, "unsupported_prospect_fact", /^not in source page: "contact us to schedule a preview"/);
    f = await fixture("steffen-unquoted", { evidence: steffenEvidence, siteText: steffenPage });
    scripts.set(f.name, [steffenDraft(unquoted)]);
    await expectHold("Steffen unquoted", f, "unsupported_prospect_fact", /^not in source page: "contact us to schedule a preview"/);
    f = await fixture("steffen-control", { evidence: steffenEvidence, siteText: `${steffenPage}\nContact us to schedule a preview.` });
    scripts.set(f.name, [steffenDraft(quoted)]);
    await expectPending("Steffen control (page has it)", f);

    console.log("\n--- Malformed claims twice → hold ---");
    f = await fixture("malformed");
    scripts.set(f.name, [{ subject: SUBJECT, body: "Hi Pat,\n\nSomething.", claims: [{ span: "Something", kind: "fact", evidence_ids: [] }] }]);
    const malformed = await runDraft(f);
    assert("malformed: lead manual_hold, no touch, 2 calls", (await leadState(f.leadId)) === "manual_hold" && (await touchesFor(f.leadId)).length === 0 && calls.get(f.name) === 2 && malformed.claim_held === 1);

    console.log("\n--- Retry that fixes the draft ---");
    f = await fixture("retry-fixes");
    scripts.set(f.name, [draft("A buyer who writes on a Sunday evening waits."), draft()]);
    await expectPending("retry fixes", f, 2);

    console.log("\n--- DoD 9: clean draft → approval binds the ledger ---");
    const cardsBefore = tg.cards.length;
    f = await fixture("clean");
    scripts.set(f.name, [draft()]);
    let touch = await expectPending("DoD 9", f);
    const card = tg.cards.slice(cardsBefore).at(-1) ?? "";
    assert("DoD 9: Telegram card lists each claim with its evidence id and fetch date", card.includes("<b>CLAIMS:</b>") && /← E2 · \d{4}-\d{2}-\d{2}/.test(card) && card.includes("[prospect_fact]") && card.includes("claim guard: pass"));
    await callback(`approve:${touch.id}`, 1);
    const all = await touchesFor(f.leadId);
    const approved = all[0];
    const snapshot = approved?.approval_snapshot as { steps?: { claim_ledger?: unknown }[] } | null;
    assert("DoD 9: touch approved, lead approved", all.every((x) => x.status === "approved") && (await leadState(f.leadId)) === "approved", tg.messages.at(-1)?.slice(0, 200));
    assert("DoD 9: snapshot carries the ledger", JSON.stringify(snapshot?.steps?.[0]?.claim_ledger) === JSON.stringify(approved?.claim_ledger) && Array.isArray(snapshot?.steps?.[0]?.claim_ledger));
    if (approved) {
      const { data: sender } = await sendDb.from("send_accounts").select("id, signature_text, instantly_campaign_id").eq("id", approved.send_account_id ?? "").maybeSingle();
      const lead = await state.getLead(f.leadId);
      const rebuild = (touches: typeof all) =>
        sequenceApprovalHash(
          buildSequenceApprovalSnapshot({ lead: { id: lead.id, email: lead.email }, sender: sender!, sequence: { version: 1, value: SEQUENCE }, touches }),
        );
      assert("DoD 9: hash recomputes equal (preflight view)", rebuild(all) === approved.approval_hash);
      const tampered = rebuild(all.map((x, i) => (i === 0 ? { ...x, claim_ledger: [] } : x)));
      assert("DoD 9: a different ledger changes the hash", tampered !== approved.approval_hash);
    }

    console.log("\n--- DoD 10: Telegram edit adding an uncovered place is refused ---");
    f = await fixture("edit");
    scripts.set(f.name, [draft()]);
    touch = await expectPending("DoD 10 setup", f);
    await callback(`edit:${touch.id}`, 2);
    const editedBody = (touch.draft_body ?? "").replace(CLEAN_MIDDLE, "Buyers in Beaumont wait the longest.");
    await processTelegramUpdate(handlerDeps, { update_id: 3, message: { message_id: 5, from: { id: APPROVER }, chat: { id: APPROVER }, text: editedBody } }, { skipStore: true });
    const refusal = tg.messages.at(-1) ?? "";
    const [afterEdit] = await touchesFor(f.leadId);
    assert("DoD 10: refused with the failing claim listed", /claim guard refused/.test(refusal) && refusal.includes("Beaumont") && refusal.includes("Edit not applied"), refusal.slice(0, 200));
    assert("DoD 10: touch still pending_approval, body not written", afterEdit?.status === "pending_approval" && afterEdit.body === null && (await leadState(f.leadId)) === "pending_approval");
    // The refused edit changed nothing; the pending edit stays open for the next reply.
    // A clean edit (a sentence deleted) is accepted, with the dropped claim removed from the ledger.
    const cleanEdit = (touch.draft_body ?? "").replace(` ${CLEAN_MIDDLE}`, "");
    await processTelegramUpdate(handlerDeps, { update_id: 4, message: { message_id: 6, from: { id: APPROVER }, chat: { id: APPROVER }, text: cleanEdit } }, { skipStore: true });
    const [edited] = await touchesFor(f.leadId);
    assert("DoD 10: a clean edit is approved and bound", edited?.status === "approved" && edited.body === cleanEdit.trim() && Array.isArray(edited.claim_ledger), tg.messages.at(-1)?.slice(0, 160));

    console.log("\n--- Approval refused when evidence ages past the limit after drafting ---");
    f = await fixture("ages");
    scripts.set(f.name, [draft()]);
    touch = await expectPending("ages setup", f);
    const aged = new Date(Date.now() - 31 * DAY).toISOString();
    await db.from("enrichment_payloads").update({ fetched_at: aged }).eq("lead_id", f.leadId);
    await callback(`approve:${touch.id}`, 5);
    const agedMsg = tg.messages.at(-1) ?? "";
    assert("aged: approval refused with stale_evidence", agedMsg.includes("stale_evidence") && (await touchesFor(f.leadId))[0]?.status === "pending_approval", agedMsg.slice(0, 160));

    console.log("\n--- A ledger-less touch cannot be approved ---");
    f = await fixture("no-ledger");
    scripts.set(f.name, [draft()]);
    touch = await expectPending("no-ledger setup", f);
    await sendDb.from("touches").update({ claim_ledger: null }).eq("id", touch.id);
    await callback(`approve:${touch.id}`, 6);
    const noLedgerMsg = tg.messages.at(-1) ?? "";
    assert("no ledger: approval refused", noLedgerMsg.includes("no valid claim ledger") && (await touchesFor(f.leadId))[0]?.status === "pending_approval", noLedgerMsg.slice(0, 160));

    assert("no network calls outside Supabase", network.length === 0, network.join(", "));
  } finally {
    await cleanup();
  }

  const after = await counts();
  console.log(`\nBEFORE ${JSON.stringify(before)}\nAFTER  ${JSON.stringify(after)}`);
  assert("row counts unchanged (scoped cleanup)", JSON.stringify(before) === JSON.stringify(after));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    for (const r of failed) console.error(`- ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error(error);
  try {
    await cleanup();
  } catch (cleanupError) {
    console.error("cleanup failed:", cleanupError);
  }
  process.exit(1);
});
