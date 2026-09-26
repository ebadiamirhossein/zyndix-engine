/**
 * scripts/test-u6c-sequence.ts — 09 §U6c DoD, S19 part (Session 19): the
 * 3-step email sequence through the real draft stage, the real Telegram
 * approval handler and the 0009d RPCs.
 *
 * SAFETY CONTRACT
 *   - Synthetic fixtures only (`*.example.com` companies, tagged; one
 *     synthetic send account `*.example.invalid`, health paused). The draft
 *     stage is scoped to fixture lead ids; no real prospect is selected.
 *   - Lead states move only through lib/state.
 *   - Mocked Anthropic and Telegram. A fetch guard fails any network call
 *     other than Supabase. Zero spend, nothing sent, no Instantly call.
 *   - Cleanup is scoped to the ids this run created, and the run asserts the
 *     row counts are identical before and after.
 *
 * Pinned in-process: evidence_policy v1 (30 d), cta_variants (the approved
 * line), email_sequence v1 (0/7/7 days) and followup_templates v1 (the
 * operator's honest close), so the DoD does not depend on which settings
 * versions are active. Other settings are read live.
 *
 * Needs 0009d_instantly_enrollments.sql applied.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import type { AnthropicClient } from "../src/lib/integrations/anthropic";
import type { TelegramClient } from "../src/lib/integrations/telegram";
import { formatSequenceApprovalMessages, TELEGRAM_TEXT_LIMIT, telegramVisibleLength } from "../src/lib/integrations/telegram-approval";
import {
  buildSequenceApprovalSnapshot,
  recomputeSequenceHash,
  sequenceApprovalHash,
  type EmailSequence,
  type SequenceApprovalSnapshot,
} from "../src/lib/sending/sequence-approval";
import { createSettingsStore } from "../src/lib/settings/core";
import { runDraftStage } from "../src/lib/stages/draft/core";
import { createStateStore } from "../src/lib/state/core";
import { processTelegramUpdate } from "../src/lib/telegram/handler";
import type { Claim } from "../src/lib/validation/llm";
import type { Database, Json } from "../src/types/database";
import type { DatabaseWithEnrollments, DatabaseWithSending } from "../src/types/database-extensions";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const raw = createServiceClient(url, key);
const db = raw as SupabaseClient<Database>;
const sendDb = raw as unknown as SupabaseClient<DatabaseWithSending>;
const rpcDb = raw as unknown as SupabaseClient<DatabaseWithEnrollments>;
const state = createStateStore(db);
const settings = createSettingsStore(db);

const APPROVER = 910_000_002;
process.env.TELEGRAM_ALLOWED_USER_IDS = String(APPROVER);

const APPROVED = "Happy to write up what I'd change, if that's useful.";
const TAG = `u6c-fixture-${Date.now()}`;
const DAY = 86_400_000;
const HONEST_CLOSE =
  "Hi {first_name},\n\nI haven't heard back, so I'll assume now isn't the right time and won't follow up again.\n\nIf it becomes a priority later, just reply to this email.";
const SEQUENCE: EmailSequence = {
  steps: [
    { step_no: 1, delay: 0, delay_unit: "days", source: "writer" },
    { step_no: 2, delay: 7, delay_unit: "days", source: "writer" },
    { step_no: 3, delay: 7, delay_unit: "days", source: "template" },
  ],
};

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

const scripts = new Map<string, unknown[]>(); // company name → writer outputs per call
const calls = new Map<string, number>();

const anthropic = {
  async complete(params: { user: string }) {
    const name = params.user.match(/"company_name":\s*"([^"]+)"/)?.[1] ?? "?";
    const n = calls.get(name) ?? 0;
    calls.set(name, n + 1);
    const outs = scripts.get(name) ?? [];
    const out = outs[Math.min(n, outs.length - 1)] ?? {};
    return { text: JSON.stringify(out), model: "mock", inputTokens: 1, outputTokens: 1, estCostUsd: 0 };
  },
} as unknown as AnthropicClient;

const tg = { cards: [] as string[][], messages: [] as string[], alerts: [] as string[] };
const telegram = {
  async sendSequenceApproval(...args: Parameters<typeof formatSequenceApprovalMessages>) {
    tg.cards.push(formatSequenceApprovalMessages(...args));
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

const handlerDeps = { db, telegram, transition: state.transition, getActiveSetting, writeNewVersion: settings.writeNewVersion };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Evidence = { source: string; observation: string };
type FixtureSpec = { fetchedDaysAgo?: number; firstName?: string | null };
type Fixture = { leadId: string; companyId: string; name: string };
const created: Fixture[] = [];
const createdAccounts: string[] = [];

const EVIDENCE: Evidence[] = [
  { source: "website", observation: "Contact page lists a shared team inbox and one office phone number." },
  { source: "website", observation: "'Serving Houston and Katy since 2004' appears in the homepage header." },
  // S20: step 2 must cite an item step 1 does not (step2_repeats_step1).
  { source: "website", observation: "The contact page offers two ways in: the office phone and the shared team inbox." },
];
const SITE = "Home\nServing Houston and Katy since 2004\nContact: team inbox, office phone";

async function fixture(label: string, spec: FixtureSpec = {}): Promise<Fixture> {
  const idx = created.length + 1;
  const name = `U6C Fixture Realty ${idx}`;
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
      first_name: spec.firstName === undefined ? "Pat" : spec.firstName,
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
    evidence: EVIDENCE as unknown as Json,
    triggers: [],
    visible_tools: [],
    recommended_angle: "speed-to-lead",
    prompt_version: 1,
    model: "fixture",
  });
  if (qe) throw new Error(`qualification: ${qe.message}`);

  const fetchedAt = new Date(Date.now() - (spec.fetchedDaysAgo ?? 1) * DAY).toISOString();
  const { error: ee } = await db.from("enrichment_payloads").insert([
    { company_id: company.id, lead_id: lead.id, source: "apify_site", fetched_at: fetchedAt, payload: [{ url: `https://${domain}/`, text: SITE }] as unknown as Json },
    { company_id: company.id, lead_id: lead.id, source: "apify_tech", fetched_at: fetchedAt, payload: { url: `https://${domain}`, signals: { hasChatWidget: false } } as unknown as Json },
  ]);
  if (ee) throw new Error(`enrichment: ${ee.message}`);

  for (const [from, to] of [
    ["sourced", "enriching"],
    ["enriching", "qualifying"],
    ["qualifying", "qualified"],
    ["qualified", "verifying"],
    ["verifying", "drafting"],
  ] as const) {
    await state.transition(lead.id, from, to, to === "drafting" ? "verified" : "enriched", { stage: `u6c fixture: ${label}` });
  }
  return f;
}

// ---------------------------------------------------------------------------
// Writer outputs (v10 shape)
// ---------------------------------------------------------------------------

const SUBJECT = "Houston and Katy enquiries";
const S_FACT = "you have been serving Houston and Katy since 2004";
const S_INBOX = "every enquiry goes to one shared team inbox";
const MIDDLE_1 = "The first person to check it decides how fast a buyer hears back.";
const S2_SPAN = "for a Houston and Katy team, the office phone and the shared team inbox are the only two ways in";
const MIDDLE_2 = "The first person to pick up owns the reply.";

function stepOne() {
  return {
    step_no: 1,
    subject: SUBJECT,
    body: `Hi Pat,\n\nYour site says ${S_FACT}, and ${S_INBOX}. ${MIDDLE_1}\n\n${APPROVED}`,
    claims: [
      { span: SUBJECT, kind: "inference", evidence_ids: ["E2"] },
      { span: S_FACT, kind: "prospect_fact", evidence_ids: ["E2"] },
      { span: S_INBOX, kind: "inference", evidence_ids: ["E1"] },
      { span: APPROVED, kind: "offer", evidence_ids: [] },
    ] as Claim[],
  };
}

function stepTwo(middle = MIDDLE_2, extra: Claim[] = [], closing = "", ids: string[] = ["E2", "E3"]) {
  return {
    step_no: 2,
    body: `Hi Pat,\n\nOne more thought: ${S2_SPAN}. ${middle}${closing ? `\n\n${closing}` : ""}`,
    claims: [{ span: S2_SPAN, kind: "inference", evidence_ids: ids }, ...extra] as Claim[],
  };
}

/** S20 (a): a step 2 citing only evidence step 1 already cites (E1, E2). */
const repeating = () => ({ steps: [stepOne(), stepTwo(MIDDLE_2, [], "", ["E1", "E2"])] });

const clean = () => ({ steps: [stepOne(), stepTwo()] });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runDraft(f: Fixture) {
  return runDraftStage({ db, anthropic, telegram, getActiveSetting, transition: state.transition }, { limit: 1, leadIds: [f.leadId] });
}

async function leadState(id: string): Promise<string> {
  return (await state.getLead(id)).state;
}

async function touchesFor(leadId: string) {
  const { data } = await sendDb.from("touches").select("*").eq("lead_id", leadId).order("step_no");
  return data ?? [];
}

type HoldDetail = { steps?: { step: number; reasons: string[]; violations: { reason: string; detail: string }[] }[]; rejections?: string[] };
async function holdEvent(leadId: string, event: string): Promise<HoldDetail | undefined> {
  const { data } = await db.from("lead_events").select("detail").eq("lead_id", leadId).eq("event", event).maybeSingle();
  return data?.detail as HoldDetail | undefined;
}

async function expectHeld(label: string, f: Fixture, event: string, writerCalls: number): Promise<HoldDetail | undefined> {
  const alertsBefore = tg.alerts.length;
  const summary = await runDraft(f);
  const touches = await touchesFor(f.leadId);
  const hold = await holdEvent(f.leadId, event);
  assert(`${label}: zero touches written`, touches.length === 0, `touches=${touches.length}`);
  assert(`${label}: lead manual_hold via ${event}`, (await leadState(f.leadId)) === "manual_hold" && hold !== undefined);
  assert(`${label}: writer calls = ${writerCalls}`, calls.get(f.name) === writerCalls, String(calls.get(f.name)));
  assert(`${label}: operator alerted once`, tg.alerts.length === alertsBefore + 1 && summary.claim_held === 1);
  return hold;
}

async function expectPending(label: string, f: Fixture, writerCalls = 1) {
  const cardsBefore = tg.cards.length;
  await runDraft(f);
  const touches = await touchesFor(f.leadId);
  assert(`${label}: lead pending_approval`, (await leadState(f.leadId)) === "pending_approval");
  assert(
    `${label}: 3 touches pending_approval (steps 1–3), claim ledgers present`,
    touches.length === 3 && touches.map((t) => t.step_no).join() === "1,2,3" && touches.every((t) => t.status === "pending_approval" && Array.isArray(t.claim_ledger)),
    touches.map((t) => `${t.step_no}:${t.status}`).join(" "),
  );
  assert(`${label}: one card`, tg.cards.length === cardsBefore + 1);
  assert(`${label}: writer calls = ${writerCalls}`, calls.get(f.name) === writerCalls, String(calls.get(f.name)));
  return touches;
}

let updateId = 1000;
function callback(data: string) {
  updateId += 1;
  return processTelegramUpdate(
    handlerDeps,
    { update_id: updateId, callback_query: { id: `cb-${updateId}`, from: { id: APPROVER }, data, message: { message_id: 1, chat: { id: APPROVER }, text: "card" } } },
    { skipStore: true },
  );
}
function reply(text: string) {
  updateId += 1;
  return processTelegramUpdate(handlerDeps, { update_id: updateId, message: { message_id: updateId, from: { id: APPROVER }, chat: { id: APPROVER }, text } }, { skipStore: true });
}

async function senderFor(id: string | null) {
  const { data } = await sendDb.from("send_accounts").select("id, signature_text, instantly_campaign_id").eq("id", id ?? "").maybeSingle();
  return data;
}

// ---------------------------------------------------------------------------
// Counts and cleanup
// ---------------------------------------------------------------------------

const COUNTED = ["companies", "leads", "touches", "lead_events", "qualification", "enrichment_payloads", "send_accounts", "capacity_ledger", "capacity_reservations", "instantly_enrollments"] as const;
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of COUNTED) {
    const { count, error } = await (raw as unknown as SupabaseClient).from(t).select("id", { count: "exact", head: true });
    if (error) throw new Error(`count ${t}: ${error.message}`);
    out[t] = count ?? 0;
  }
  return out;
}

async function cleanup(): Promise<void> {
  const leadIds = created.map((f) => f.leadId);
  const companyIds = created.map((f) => f.companyId);
  if (leadIds.length > 0) {
    for (const t of ["touches", "lead_events", "qualification_history", "qualification", "enrichment_payloads"] as const) {
      const { error } = await db.from(t).delete().in("lead_id", leadIds);
      if (error) throw new Error(`cleanup ${t}: ${error.message}`);
    }
    const { error: le } = await db.from("leads").delete().in("id", leadIds);
    if (le) throw new Error(`cleanup leads: ${le.message}`);
    const { error: ce } = await db.from("companies").delete().in("id", companyIds);
    if (ce) throw new Error(`cleanup companies: ${ce.message}`);
  }
  if (createdAccounts.length > 0) {
    // capacity_ledger / capacity_reservations cascade from send_accounts.
    const { error } = await db.from("send_accounts").delete().in("id", createdAccounts);
    if (error) throw new Error(`cleanup send_accounts: ${error.message}`);
  }
  console.log(`\nCleanup: removed ${leadIds.length} fixture leads/companies and ${createdAccounts.length} synthetic send account(s).`);
  created.length = 0;
  createdAccounts.length = 0;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { error: tableError } = await rpcDb.from("instantly_enrollments").select("id").limit(1);
  if (tableError) {
    console.error(`instantly_enrollments is not readable (${tableError.message}). Apply supabase/migrations/0009d_instantly_enrollments.sql first.`);
    process.exit(1);
  }

  const before = await counts();
  console.log(`BEFORE ${JSON.stringify(before)}\n`);

  try {
    const { data: acct, error: ae } = await sendDb
      .from("send_accounts")
      .insert({ kind: "email", identifier: `${TAG}@u6c.example.invalid`, health: "paused" })
      .select("id")
      .single();
    if (ae || !acct) throw new Error(`send account: ${ae?.message}`);
    createdAccounts.push(acct.id);

    // ---------------------------------------------------------------- D1
    console.log("--- D1: clean steps 1–2 + template step 3 ---");
    let f = await fixture("d1");
    scripts.set(f.name, [clean()]);
    let touches = await expectPending("D1", f);
    const [t1, t2, t3] = touches;
    assert("D1: step 1 has the subject; follow-ups have none", t1?.subject === SUBJECT && t2?.subject === null && t3?.subject === null);
    assert(
      "D1: step 3 is the operator's template, first name filled, footer appended",
      (t3?.draft_body ?? "").startsWith("Hi Pat,\n\nI haven't heard back, so I'll assume now isn't the right time and won't follow up again.\n\nIf it becomes a priority later, just reply to this email.") &&
        /Reply STOP/.test(t3?.draft_body ?? ""),
    );
    assert("D1: every step carries the compliance footer", touches.every((t) => /Reply STOP/.test(t.draft_body ?? "")));
    assert("D1: step 3 ledger is [] (template cites nothing)", Array.isArray(t3?.claim_ledger) && (t3?.claim_ledger as unknown[]).length === 0);
    const card = tg.cards.at(-1) ?? [];
    const cardText = card.join("\n");
    assert("D1: the card is one message ≤ 4096", card.length === 1 && telegramVisibleLength(card[0]!) <= TELEGRAM_TEXT_LIMIT, String(telegramVisibleLength(cardText)));
    assert(
      "D1: card shows every step with '+7 days · same thread', the quote line and claims",
      /STEP 1 · day 0/.test(cardText) &&
        /STEP 2 · \+7 days · same thread/.test(cardText) &&
        /STEP 3 · \+7 days · same thread/.test(cardText) &&
        (cardText.match(/Instantly adds a quote of step 1 below/g) ?? []).length === 2 &&
        /← E2 · \d{4}-\d{2}-\d{2} · <i>/.test(cardText),
    );

    // ---------------------------------------------------------------- A1
    console.log("\n--- A1: approve → all 3 approved, one hash, full snapshot ---");
    await callback(`approve:${t1!.id}`);
    touches = await touchesFor(f.leadId);
    const hashes = new Set(touches.map((t) => t.approval_hash));
    assert("A1: all 3 approved, lead approved", touches.every((t) => t.status === "approved") && (await leadState(f.leadId)) === "approved", tg.messages.at(-1)?.slice(0, 160));
    assert("A1: one shared hash on every step", hashes.size === 1 && !hashes.has(null));
    const snap = touches[0]?.approval_snapshot as unknown as SequenceApprovalSnapshot;
    const sender = await senderFor(touches[0]?.send_account_id ?? null);
    assert(
      "A1: snapshot binds every subject (rendered), composed body, delay, sender, signature, version",
      snap?.kind === "email_sequence" &&
        snap.steps.map((s) => s.subject).join("|") === `${SUBJECT}|Re: ${SUBJECT}|Re: ${SUBJECT}` &&
        snap.steps.map((s) => s.delay).join() === "0,7,7" &&
        snap.steps.every((s) => sender?.signature_text && s.body.includes(sender.signature_text.trim())) &&
        snap.send_account_id === sender?.id &&
        snap.campaign_id === sender?.instantly_campaign_id &&
        snap.sequence_setting_version === 1,
    );
    const lead1 = await state.getLead(f.leadId);
    const recomputed = recomputeSequenceHash({ lead: { id: lead1.id, email: lead1.email }, sender: sender!, sequence: { version: 1, value: SEQUENCE }, touches });
    assert("A1: the hash recomputes equal from the stored rows (preflight view)", recomputed === touches[0]?.approval_hash);

    // ---------------------------------------------------------------- A4
    console.log("\n--- A4: delay setting or signature changed after approval ---");
    const moved: EmailSequence = { steps: SEQUENCE.steps.map((s) => (s.step_no === 2 ? { ...s, delay: 14 } : s)) };
    assert(
      "A4: a new email_sequence delay → the recomputed hash differs (stale_approval)",
      recomputeSequenceHash({ lead: { id: lead1.id, email: lead1.email }, sender: sender!, sequence: { version: 2, value: moved }, touches }) !== touches[0]?.approval_hash,
    );
    assert(
      "A4: a changed signature → the recomputed hash differs (stale_approval)",
      recomputeSequenceHash({ lead: { id: lead1.id, email: lead1.email }, sender: { ...sender!, signature_text: "Someone else" }, sequence: { version: 1, value: SEQUENCE }, touches }) !==
        touches[0]?.approval_hash,
    );
    // A second approve press changes nothing (fenced).
    const beforeRepress = JSON.stringify(touches.map((t) => [t.id, t.approval_hash, t.approved_at]));
    await callback(`approve:${t1!.id}`);
    assert("A1: a repeated approve press changes nothing", JSON.stringify((await touchesFor(f.leadId)).map((t) => [t.id, t.approval_hash, t.approved_at])) === beforeRepress);

    // ---------------------------------------------------------------- D2
    console.log("\n--- D2: step 2 says '9pm on a Saturday' ---");
    f = await fixture("d2");
    scripts.set(f.name, [{ steps: [stepOne(), stepTwo("A buyer who writes at 9pm on a Saturday waits.")] }]);
    let hold = await expectHeld("D2", f, "claim_guard_hold", 2);
    assert("D2: invented_timing named on step 2 (and only step 2)", hold?.steps?.length === 1 && hold.steps[0]!.step === 2 && hold.steps[0]!.reasons.includes("invented_timing"), JSON.stringify(hold?.steps?.map((s) => [s.step, s.reasons])));

    // ---------------------------------------------------------------- D3
    console.log("\n--- D3: step 2 offer outside the approved line ---");
    f = await fixture("d3");
    scripts.set(f.name, [{ steps: [stepOne(), stepTwo(MIDDLE_2, [], "I can set up an instant reply for you.")] }]);
    hold = await expectHeld("D3", f, "claim_guard_hold", 2);
    assert("D3: unapproved_offer on step 2", hold?.steps?.some((s) => s.step === 2 && s.reasons.includes("unapproved_offer")) === true, JSON.stringify(hold?.steps?.map((s) => [s.step, s.reasons])));

    // ---------------------------------------------------------------- D4
    console.log("\n--- D4: sequence_shape_invalid → retry once → hold ---");
    f = await fixture("d4-count");
    scripts.set(f.name, [{ steps: [stepOne()] }]);
    hold = await expectHeld("D4 wrong count", f, "sequence_shape_invalid", 2);
    assert("D4 wrong count: both attempts named sequence_shape_invalid", (hold?.rejections ?? []).filter((r) => r.includes("sequence_shape_invalid")).length === 2, (hold?.rejections ?? []).join(" | "));
    f = await fixture("d4-malformed");
    scripts.set(f.name, [{ subject: SUBJECT, body: "Hi Pat,\n\nSomething.", claims: [] }]);
    await expectHeld("D4 malformed (v9 shape)", f, "sequence_shape_invalid", 2);
    f = await fixture("d4-retry");
    scripts.set(f.name, [{ steps: [stepOne(), { ...stepTwo(), subject: "Another subject" }] }, clean()]);
    await expectPending("D4 step-2 subject, then fixed on the retry", f, 2);

    // ---------------------------------------------------------------- freshness
    console.log("\n--- F1 / F2 / F3 / operator cases: per-step freshness ---");
    f = await fixture("f-22", { fetchedDaysAgo: 22 });
    scripts.set(f.name, [clean()]);
    await expectPending("22 days", f);
    f = await fixture("f1-23", { fetchedDaysAgo: 23 - 1 / 24 });
    scripts.set(f.name, [clean()]);
    await expectPending("F1 23 days (−1 h) + 7 = 30", f);
    f = await fixture("f2-24", { fetchedDaysAgo: 24 });
    scripts.set(f.name, [clean()]);
    // Like U6b's 31-day case, a writer-step refusal gets its one revision retry.
    hold = await expectHeld("F2 24 days", f, "claim_guard_hold", 2);
    const stale = hold?.steps?.find((s) => s.step === 2)?.violations.find((v) => v.reason === "stale_evidence");
    assert("F2: step 2 refused 'step 2: 24d + 7d > 30d'", /^step 2: 24d \+ 7d > 30d/.test(stale?.detail ?? ""), stale?.detail);
    assert("F3: step 1 and the step-3 template are not refused", hold?.steps?.map((s) => s.step).join() === "2", JSON.stringify(hold?.steps?.map((s) => s.step)));

    console.log("\n--- F4: 22 days at draft, 24 days at approval ---");
    f = await fixture("f4", { fetchedDaysAgo: 22 });
    scripts.set(f.name, [clean()]);
    touches = await expectPending("F4 setup (22 d)", f);
    await db.from("enrichment_payloads").update({ fetched_at: new Date(Date.now() - 24 * DAY).toISOString() }).eq("lead_id", f.leadId);
    await callback(`approve:${touches[0]!.id}`);
    const f4msg = tg.messages.at(-1) ?? "";
    assert("F4: approval refused, stale_evidence on step 2", /step 2: stale_evidence/.test(f4msg) && /24d \+ 7d > 30d/.test(f4msg), f4msg.slice(0, 200));
    assert("F4: all 3 still pending_approval", (await touchesFor(f.leadId)).every((t) => t.status === "pending_approval" && t.approval_hash === null));

    // ---------------------------------------------------------------- A2 / A3
    console.log("\n--- A2: /edit 2 adds 'Beaumont' ---");
    f = await fixture("a2");
    scripts.set(f.name, [clean()]);
    touches = await expectPending("A2 setup", f);
    const unedited = touches;
    await callback(`edit:${touches[1]!.id}`);
    assert("A2: the edit prompt names step 2", /new body for STEP 2/.test(tg.messages.at(-2) ?? tg.messages.at(-1) ?? ""), tg.messages.slice(-2).join(" / ").slice(0, 200));
    await reply((touches[1]!.draft_body ?? "").replace(MIDDLE_2, "Buyers in Beaumont wait the longest."));
    const a2msg = tg.messages.at(-1) ?? "";
    assert("A2: refused with uncovered_fact, 'Edit not applied'", a2msg.includes("uncovered_fact") && a2msg.includes("Beaumont") && a2msg.includes("Edit not applied"), a2msg.slice(0, 200));
    assert("A2: all 3 still pending, nothing written", (await touchesFor(f.leadId)).every((t) => t.status === "pending_approval" && t.body === null));

    console.log("\n--- A3: a valid /edit 2 ---");
    const cleanEdit = (touches[1]!.draft_body ?? "").replace(` ${MIDDLE_2}`, "");
    await reply(cleanEdit);
    touches = await touchesFor(f.leadId);
    const a3sender = await senderFor(touches[0]?.send_account_id ?? null);
    const lead3 = await state.getLead(f.leadId);
    const uneditedHash = sequenceApprovalHash(
      buildSequenceApprovalSnapshot({
        lead: { id: lead3.id, email: lead3.email },
        sender: a3sender!,
        sequence: { version: 1, value: SEQUENCE },
        touches: unedited.map((t) => ({ ...t, body: t.draft_body })),
      }),
    );
    assert("A3: sequence approved with the edited step 2", touches.every((t) => t.status === "approved") && touches[1]?.body === cleanEdit.trim(), tg.messages.slice(-3).join(" / ").slice(0, 200));
    assert("A3: a new hash, ≠ the unedited sequence's hash (the old one is stale)", new Set(touches.map((t) => t.approval_hash)).size === 1 && touches[0]?.approval_hash !== uneditedHash);
    assert("A3: steps 1 and 3 keep their drafted bodies", touches[0]?.body === touches[0]?.draft_body && touches[2]?.body === touches[2]?.draft_body);

    assert("A3: the kept footer is not doubled", ((touches[1]?.body ?? "").match(/Reply STOP/g) ?? []).length === 1);

    // ---------------------------------------------------------------- S20 (c): footer
    console.log("\n--- S20 (c): an edit that drops the compliance footer gets it re-appended ---");
    const footer = String((await getActiveSetting("compliance_footer")).value).trim();
    f = await fixture("footer");
    scripts.set(f.name, [clean()]);
    touches = await expectPending("footer setup", f);
    const noFooter = (touches[1]!.draft_body ?? "").replace(`\n\n${footer}`, "").replace(` ${MIDDLE_2}`, "");
    assert("footer: the edit text really has no footer", !noFooter.includes(footer) && !/Reply STOP/.test(noFooter));
    await callback(`edit:${touches[1]!.id}`);
    await reply(noFooter);
    touches = await touchesFor(f.leadId);
    const fsnap = touches[0]?.approval_snapshot as unknown as SequenceApprovalSnapshot;
    assert(
      "footer: approved; step 2 body = the edit + the compliance footer, once",
      touches.every((t) => t.status === "approved") &&
        touches[1]?.body === `${noFooter.trim()}\n\n${footer}` &&
        ((touches[1]?.body ?? "").match(/Reply STOP/g) ?? []).length === 1,
      (touches[1]?.body ?? "").slice(-120),
    );
    assert("footer: the hash binds it (snapshot step 2 composed body carries the footer)", (fsnap?.steps[1]?.body ?? "").includes(footer));
    assert("footer: the APPROVED text shows it", tg.messages.slice(-3).join("\n").includes("Reply STOP"));

    // ---------------------------------------------------------------- S20 (a): step2_repeats_step1
    console.log("\n--- S20 (a): step 2 cites only step 1's evidence → retry → hold ---");
    f = await fixture("repeat-hold");
    scripts.set(f.name, [repeating(), repeating()]);
    hold = await expectHeld("repeat", f, "step2_repeats_step1", 2);
    assert(
      "repeat: both attempts named step2_repeats_step1 with the ids",
      (hold?.rejections ?? []).filter((r) => r.includes("step 2: step2_repeats_step1 — cites only E1, E2 (step 1 cites E1, E2)")).length === 2,
      (hold?.rejections ?? []).join(" | "),
    );
    f = await fixture("repeat-retry");
    scripts.set(f.name, [repeating(), clean()]);
    await expectPending("repeat, then a new id (E3) on the retry", f, 2);

    console.log("\n--- S20 (a): re-checked at approval ---");
    f = await fixture("repeat-approval");
    scripts.set(f.name, [clean()]);
    touches = await expectPending("repeat-approval setup", f);
    const ledger2 = (touches[1]!.claim_ledger as unknown as Claim[]).map((c) => ({ ...c, evidence_ids: c.evidence_ids.length ? ["E2"] : [] }));
    await sendDb.from("touches").update({ claim_ledger: ledger2 as unknown as Json }).eq("id", touches[1]!.id);
    await callback(`approve:${touches[0]!.id}`);
    const repeatMsg = tg.messages.at(-1) ?? "";
    assert(
      "repeat: approval refused with step2_repeats_step1, nothing approved",
      repeatMsg.includes("Not approved: step2_repeats_step1") &&
        repeatMsg.includes("step 2: step2_repeats_step1 — cites only E2") &&
        (await touchesFor(f.leadId)).every((t) => t.status === "pending_approval"),
      repeatMsg.slice(0, 200),
    );

    // ---------------------------------------------------------------- kill
    console.log("\n--- Kill kills the whole sequence ---");
    f = await fixture("kill");
    scripts.set(f.name, [clean()]);
    touches = await expectPending("kill setup", f);
    await callback(`kill:${touches[0]!.id}`);
    assert("kill: all 3 killed, lead parked", (await touchesFor(f.leadId)).every((t) => t.status === "killed") && (await leadState(f.leadId)) === "parked");

    // ---------------------------------------------------------------- incomplete / fence
    console.log("\n--- An incomplete sequence cannot be approved; the RPC fence is all-or-none ---");
    f = await fixture("fence");
    scripts.set(f.name, [clean()]);
    touches = await expectPending("fence setup", f);
    await sendDb.from("touches").update({ status: "killed" }).eq("id", touches[2]!.id);
    await callback(`approve:${touches[0]!.id}`);
    const incMsg = tg.messages.at(-1) ?? "";
    assert("incomplete: refused (steps [1,2] vs [1,2,3])", /steps \[1,2\]/.test(incMsg) && (await touchesFor(f.leadId)).filter((t) => t.status === "approved").length === 0, incMsg.slice(0, 160));
    const { data: rpcResult, error: rpcError } = await rpcDb.rpc("approve_email_sequence", {
      p_lead_id: f.leadId,
      p_steps: touches.map((t) => ({ touch_id: t.id, body: t.draft_body, claim_ledger: t.claim_ledger })) as unknown as Json,
      p_hash: "test-hash",
      p_snapshot: { kind: "email_sequence" } as unknown as Json,
      p_send_account_id: acct.id,
      p_approved_by: "test:u6c",
    });
    assert(
      "fence: approve_email_sequence with one step not pending → not_pending, nothing approved",
      !rpcError && (rpcResult as { status?: string })?.status === "not_pending" && (await touchesFor(f.leadId)).every((t) => t.status !== "approved" && t.approval_hash === null),
      rpcError?.message ?? JSON.stringify(rpcResult),
    );

    // ---------------------------------------------------------------- template variable
    console.log("\n--- A lead with no first name → template_variable_missing hold ---");
    f = await fixture("no-first-name", { firstName: null });
    scripts.set(f.name, [clean()]);
    await expectHeld("no first name", f, "template_variable_missing", 1);

    // ---------------------------------------------------------------- record_provider_send
    console.log("\n--- record_provider_send: counted exactly once, quota kept ---");
    const day = "2026-09-26";
    const r1 = await rpcDb.rpc("record_provider_send", { p_send_account_id: acct.id, p_date: day, p_quota: 15, p_email_id: `${TAG}-email-1` });
    const r2 = await rpcDb.rpc("record_provider_send", { p_send_account_id: acct.id, p_date: day, p_quota: 15, p_email_id: `${TAG}-email-1` });
    const r3 = await rpcDb.rpc("record_provider_send", { p_send_account_id: acct.id, p_date: day, p_quota: 30, p_email_id: `${TAG}-email-2` });
    const { data: ledger } = await rpcDb.from("capacity_ledger").select("quota, used, accepted, reserved").eq("send_account_id", acct.id).eq("date", day).single();
    assert(
      "record_provider_send: first recorded, redelivery 'already'",
      (r1.data as { status?: string })?.status === "recorded" && (r2.data as { status?: string })?.status === "already",
      JSON.stringify([r1.data ?? r1.error?.message, r2.data ?? r2.error?.message]),
    );
    assert("record_provider_send: 2 distinct emails → used 2, accepted 2, reserved 0", ledger?.used === 2 && ledger?.accepted === 2 && ledger?.reserved === 0, JSON.stringify(ledger));
    assert("record_provider_send: first-of-day sets quota 15; a higher p_quota never raises it", ledger?.quota === 15 && (r3.data as { quota?: number })?.quota === 15, JSON.stringify(ledger));

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
