// U6c sequence rules (09 §U6c, Session 19). Pure: no DB, no network,
// synthetic data. Run: pnpm test:sequence-rules
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatSequenceApprovalMessages,
  TELEGRAM_TEXT_LIMIT,
  telegramVisibleLength,
  type SequenceCardStep,
} from "@/lib/integrations/telegram-approval";
import { sequenceApprovalButtons } from "@/lib/integrations/telegram";
import { canonicalJson, composeOutboundBody } from "@/lib/sending/approval";
import { preflight, type PreflightContext } from "@/lib/sending/preflight";
import {
  buildSequenceApprovalSnapshot,
  cumulativeOffsetDays,
  recomputeSequenceHash,
  sequenceApprovalHash,
  SequenceShapeError,
  type EmailSequence,
  type SequenceTouch,
} from "@/lib/sending/sequence-approval";
import { emailSequenceSchema, followupTemplatesSchema } from "@/lib/validation/jsonb";
import { sequenceShapeIssues, writerSequenceOutputSchema, type Claim } from "@/lib/validation/llm";

import type { ClaimEvidence } from "./claims";
import type { ClaimContext } from "./claims-context";
import {
  checkSequenceClaims,
  renderFollowupTemplate,
  sequenceConfigIssues,
  writerStepNos,
  type SequenceStepDraft,
} from "./sequence";

const NOW = new Date("2026-09-29T06:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

const APPROVED = "Happy to write up what I'd change, if that's useful.";
const FOOTER = "Zyndix, MB · Gerosios Vilties g. 6-76, Vilnius, Lithuania\nNot useful? Reply STOP and I won't write again.";
const HONEST_CLOSE =
  "Hi {first_name},\n\nI haven't heard back, so I'll assume now isn't the right time and won't follow up again.\n\nIf it becomes a priority later, just reply to this email.";

const SEQUENCE: EmailSequence = emailSequenceSchema.parse({
  steps: [
    { step_no: 1, delay: 0, delay_unit: "days", source: "writer" },
    { step_no: 2, delay: 7, delay_unit: "days", source: "writer" },
    { step_no: 3, delay: 7, delay_unit: "days", source: "template" },
  ],
});
const TEMPLATES = followupTemplatesSchema.parse({ templates: [{ step_no: 3, id: "honest_close", body: HONEST_CLOSE }] });

const EVIDENCE: ClaimEvidence[] = [
  { id: "E1", source: "website", observation: "Contact page lists a shared team inbox and one office phone number." },
  { id: "E2", source: "website", observation: "'Serving Houston and Katy since 2004' appears in the homepage header." },
];
const SITE = "Home\nServing Houston and Katy since 2004\nContact: team inbox, office phone";

function ctx(fetchedDaysAgo: number): ClaimContext {
  return {
    evidence: EVIDENCE,
    siteText: SITE,
    techSignals: { hasChatWidget: false },
    evidenceFetchedAt: daysAgo(fetchedDaysAgo),
    maxAgeDays: 30,
    evidencePolicyVersion: 1,
    approvedOfferLines: [APPROVED],
    proofPoint: null,
    allowNames: ["Pat", "Fixture", "Test Realty", "test.example", "Zyndix"],
    visibleTools: [],
    contradictions: [],
    contextTexts: ["Test Realty answers every enquiry by hand from one shared team inbox."],
    complianceFooter: FOOTER,
  };
}

const SUBJECT = "Houston and Katy enquiries";
const S_FACT = "you have been serving Houston and Katy since 2004";
const S_INBOX = "every enquiry goes to one shared team inbox";
const STEP2_SPAN = "the office phone and the shared team inbox are the only two ways in";

function step1(): SequenceStepDraft {
  return {
    step_no: 1,
    source: "writer",
    subject: SUBJECT,
    body: `Hi Pat,\n\nYour site says ${S_FACT}, and ${S_INBOX}. The first person to check it decides how fast a buyer hears back.\n\n${APPROVED}\n\n${FOOTER}`,
    claims: [
      { span: SUBJECT, kind: "inference", evidence_ids: ["E2"] },
      { span: S_FACT, kind: "prospect_fact", evidence_ids: ["E2"] },
      { span: S_INBOX, kind: "inference", evidence_ids: ["E1"] },
      { span: APPROVED, kind: "offer", evidence_ids: [] },
    ],
  };
}

function step2(middle = "The first person to pick up owns the reply."): SequenceStepDraft {
  return {
    step_no: 2,
    source: "writer",
    subject: null,
    body: `Hi Pat,\n\nOne more thought: ${STEP2_SPAN}. ${middle}\n\n${FOOTER}`,
    claims: [{ span: STEP2_SPAN, kind: "inference", evidence_ids: ["E1"] }],
  };
}

function step3(): SequenceStepDraft {
  return {
    step_no: 3,
    source: "template",
    subject: null,
    body: `${renderFollowupTemplate(HONEST_CLOSE, { first_name: "Pat" })!}\n\n${FOOTER}`,
    claims: [],
  };
}

describe("email_sequence / followup_templates schemas", () => {
  test("v1 (0/7/7 days, writer, writer, template) parses; cumulative days 0/7/14", () => {
    assert.deepEqual([...cumulativeOffsetDays(SEQUENCE).entries()], [[1, 0], [2, 7], [3, 14]]);
    assert.deepEqual(writerStepNos(SEQUENCE), [1, 2]);
    assert.deepEqual(sequenceConfigIssues(SEQUENCE, TEMPLATES), []);
  });
  const bad: Array<[string, unknown, RegExp]> = [
    ["a 5-day delay", { steps: [{ step_no: 1, delay: 0, delay_unit: "days", source: "writer" }, { step_no: 2, delay: 5, delay_unit: "days", source: "writer" }] }, /multiple of 7/],
    ["minutes", { steps: [{ step_no: 1, delay: 0, delay_unit: "days", source: "writer" }, { step_no: 2, delay: 7, delay_unit: "minutes", source: "writer" }] }, /whole days/],
    ["step 1 delay 7", { steps: [{ step_no: 1, delay: 7, delay_unit: "days", source: "writer" }] }, /step 1 has delay 0/],
    ["a follow-up delay 0", { steps: [{ step_no: 1, delay: 0, delay_unit: "days", source: "writer" }, { step_no: 2, delay: 0, delay_unit: "days", source: "writer" }] }, /delay > 0/],
    ["non-contiguous", { steps: [{ step_no: 1, delay: 0, delay_unit: "days", source: "writer" }, { step_no: 3, delay: 7, delay_unit: "days", source: "writer" }] }, /contiguous/],
    ["template step 1", { steps: [{ step_no: 1, delay: 0, delay_unit: "days", source: "template" }] }, /written by the writer/],
    ["writer after template", { steps: [{ step_no: 1, delay: 0, delay_unit: "days", source: "writer" }, { step_no: 2, delay: 7, delay_unit: "days", source: "template" }, { step_no: 3, delay: 7, delay_unit: "days", source: "writer" }] }, /before template/],
  ];
  for (const [name, value, message] of bad) {
    test(`refuses ${name}`, () => {
      const r = emailSequenceSchema.safeParse(value);
      assert.equal(r.success, false);
      assert.match(r.error!.issues.map((i) => i.message).join(" | "), message);
    });
  }
  test("template: only {first_name}; unknown placeholders and stray braces refused", () => {
    assert.equal(followupTemplatesSchema.safeParse({ templates: [{ step_no: 3, id: "x", body: "Hi {company}" }] }).success, false);
    assert.equal(followupTemplatesSchema.safeParse({ templates: [{ step_no: 3, id: "x", body: "Hi {first_name" }] }).success, false);
  });
  test("a template step with no template is a config issue", () => {
    assert.match(sequenceConfigIssues(SEQUENCE, { templates: [{ step_no: 4, id: "x", body: "Bye." }] }).join(), /step 3/);
  });
  test("{first_name} missing → null (never 'Hi ,')", () => {
    assert.equal(renderFollowupTemplate(HONEST_CLOSE, { first_name: null }), null);
    assert.equal(renderFollowupTemplate(HONEST_CLOSE, { first_name: "  " }), null);
    assert.match(renderFollowupTemplate(HONEST_CLOSE, { first_name: "Pat" })!, /^Hi Pat,\n\nI haven't heard back/);
  });
});

describe("writer v10 output shape (sequence_shape_invalid)", () => {
  const claims: Claim[] = [{ span: "x", kind: "question", evidence_ids: [] }];
  const ok = { steps: [{ step_no: 1, subject: "s", body: "b", claims }, { step_no: 2, body: "b", claims }] };
  test("clean shape → no issues", () => {
    assert.deepEqual(sequenceShapeIssues(writerSequenceOutputSchema.parse(ok), [1, 2]), []);
  });
  test("wrong count, step-2 subject, missing step-1 subject", () => {
    assert.match(sequenceShapeIssues(writerSequenceOutputSchema.parse({ steps: [ok.steps[0]] }), [1, 2]).join(), /expected steps \[1,2\]/);
    assert.match(sequenceShapeIssues(writerSequenceOutputSchema.parse({ steps: [ok.steps[0], { ...ok.steps[1], subject: "re" }] }), [1, 2]).join(), /step 2 must not have a subject/);
    assert.match(sequenceShapeIssues(writerSequenceOutputSchema.parse({ steps: [{ ...ok.steps[0], subject: undefined }, ok.steps[1]] }), [1, 2]).join(), /step 1 must have a subject/);
  });
  test("v9 single-email output does not parse as v10", () => {
    assert.equal(writerSequenceOutputSchema.safeParse({ subject: "s", body: "b", claims }).success, false);
  });
});

describe("per-step claim guard (template mode, offset freshness)", () => {
  const all = () => [step1(), step2(), step3()];
  test("the operator's exact template passes template mode (no evidence cited)", () => {
    assert.deepEqual(checkSequenceClaims(ctx(3), [step3()], SEQUENCE, NOW), { ok: true });
  });
  test("22 days → pass", () => {
    assert.deepEqual(checkSequenceClaims(ctx(22), all(), SEQUENCE, NOW), { ok: true });
  });
  test("23 days (−1 h) + 7 = 30 → pass (F1)", () => {
    assert.deepEqual(checkSequenceClaims(ctx(23 - 1 / 24), all(), SEQUENCE, NOW), { ok: true });
  });
  test("24 days → step 2 refused 'step 2: 24d + 7d > 30d'; step 1 and step 3 are not (F2, F3)", () => {
    const r = checkSequenceClaims(ctx(24), all(), SEQUENCE, NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.failures.map((f) => f.step), [2]);
    const v = r.failures[0]!.violations.find((x) => x.reason === "stale_evidence");
    assert.ok(v);
    assert.match(v.detail, /^step 2: 24d \+ 7d > 30d/);
  });
  test("step 2 '9pm on a Saturday' → invented_timing on step 2 only", () => {
    const r = checkSequenceClaims(ctx(3), [step1(), step2("Buyers who write at 9pm on a Saturday wait."), step3()], SEQUENCE, NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.failures.map((f) => f.step), [2]);
    assert.ok(r.failures[0]!.violations.some((v) => v.reason === "invented_timing"));
  });
  test("template step with an offer outside the approved line is refused (template mode keeps offer rules)", () => {
    const bad = { ...step3(), body: `Hi Pat,\n\nWorth a quick call next month?\n\n${FOOTER}` };
    const r = checkSequenceClaims(ctx(3), [bad], SEQUENCE, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.failures[0]!.violations.some((v) => v.reason === "unapproved_offer"));
  });
  test("a writer step 2 with no cited evidence is still refused (no_cited_evidence applies to writer steps)", () => {
    const bare = { ...step2(), claims: [] };
    const r = checkSequenceClaims(ctx(3), [bare], SEQUENCE, NOW);
    assert.equal(r.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Sequence approval snapshot and hash
// ---------------------------------------------------------------------------

const SIGNATURE = "Amir Ebadi\nZyndix, Vilnius\nzyndix.com";
const SENDER = { id: "acct-1", identifier: "amir@getzyndix.com", health: "ok", instantly_campaign_id: "camp-1", signature_text: SIGNATURE as string | null };
const LEAD = { id: "lead-1", email: "Pat@Test.example" };

function touches(): SequenceTouch[] {
  return [step1(), step2(), step3()].map((s) => ({
    id: `touch-${s.step_no}`,
    step_no: s.step_no,
    channel: "email",
    subject: s.step_no === 1 ? s.subject : null,
    body: s.body,
    prompt_version: 10,
    claim_ledger: s.claims,
  }));
}

function snapshot(over: { sequence?: EmailSequence; version?: number; signature?: string | null; t?: SequenceTouch[] } = {}) {
  return buildSequenceApprovalSnapshot({
    lead: LEAD,
    sender: { ...SENDER, signature_text: over.signature === undefined ? SIGNATURE : over.signature },
    sequence: { version: over.version ?? 1, value: over.sequence ?? SEQUENCE },
    touches: over.t ?? touches(),
  });
}

describe("SequenceApprovalSnapshot / hash (A1, A4)", () => {
  test("binds every step: rendered subject, composed body, delay, ledger; sender, signature, campaign, version", () => {
    const s = snapshot();
    assert.equal(s.kind, "email_sequence");
    assert.equal(s.recipient, "pat@test.example");
    assert.equal(s.send_account_id, "acct-1");
    assert.equal(s.campaign_id, "camp-1");
    assert.equal(s.sequence_setting_version, 1);
    assert.deepEqual(s.steps.map((x) => x.subject), [SUBJECT, `Re: ${SUBJECT}`, `Re: ${SUBJECT}`]);
    assert.deepEqual(s.steps.map((x) => x.delay), [0, 7, 7]);
    assert.equal(s.steps[1]!.body, composeOutboundBody(step2().body, SIGNATURE));
    assert.ok(s.steps.every((x) => x.body.includes(SIGNATURE)));
    assert.deepEqual(s.steps[2]!.claim_ledger, []);
  });
  test("hash is deterministic and independent of touch order and key order", () => {
    const a = sequenceApprovalHash(snapshot());
    const b = sequenceApprovalHash(snapshot({ t: touches().reverse() }));
    assert.equal(a, b);
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  });
  test("a changed delay, setting version, signature or step text changes the hash (A4, A3)", () => {
    const base = sequenceApprovalHash(snapshot());
    const moved = emailSequenceSchema.parse({ steps: SEQUENCE.steps.map((s) => (s.step_no === 2 ? { ...s, delay: 14 } : s)) });
    assert.notEqual(sequenceApprovalHash(snapshot({ sequence: moved, version: 2 })), base);
    assert.notEqual(sequenceApprovalHash(snapshot({ version: 2 })), base);
    assert.notEqual(sequenceApprovalHash(snapshot({ signature: "Amir" })), base);
    const edited = touches().map((t) => (t.step_no === 2 ? { ...t, body: `${t.body} ` + "x" } : t));
    assert.notEqual(sequenceApprovalHash(snapshot({ t: edited })), base);
  });
  test("a missing step or a missing step-1 subject cannot be snapshotted", () => {
    assert.throws(() => snapshot({ t: touches().slice(0, 2) }), SequenceShapeError);
    assert.throws(() => snapshot({ t: touches().map((t) => (t.step_no === 1 ? { ...t, subject: null } : t)) }), SequenceShapeError);
    assert.equal(recomputeSequenceHash({ lead: LEAD, sender: SENDER, sequence: { version: 1, value: SEQUENCE }, touches: touches().slice(1) }), null);
  });
});

// ---------------------------------------------------------------------------
// Preflight hash bridge (plan: narrow bridge, no new refusals)
// ---------------------------------------------------------------------------

function preflightCtx(step: 1 | 2, mutate?: (c: PreflightContext) => void): PreflightContext {
  const s = snapshot();
  const hash = sequenceApprovalHash(s);
  const stored = touches().map((t) => ({ ...t }));
  const touch = stored.find((t) => t.step_no === step)!;
  const c: PreflightContext = {
    now: NOW,
    touch: {
      id: touch.id,
      step_no: step,
      channel: "email",
      direction: "outbound",
      status: "approved",
      subject: touch.subject,
      body: touch.body,
      prompt_version: 10,
      approval_hash: hash,
      claim_ledger: touch.claim_ledger,
      approval_snapshot: s,
    },
    lead: {
      id: LEAD.id,
      state: step === 1 ? "approved" : "sent",
      email: LEAD.email,
      email_status: "valid",
      email_verified_at: "2026-09-20T00:00:00.000Z",
      timezone: "Europe/Vilnius",
      do_not_contact: false,
      send_account_id: step === 1 ? null : SENDER.id,
    },
    company: { domain: "test.example", timezone: null, country: "LT" },
    sender: { ...SENDER },
    providerHealth: { verdict: "healthy", warmupScore: 100 },
    suppression: { email: false, domain: false },
    hasReply: false,
    companyConflicts: 0,
    capacityRemaining: 15,
    threadAnchor: step === 1 ? null : { emailId: "e-1", subject: SUBJECT },
    policy: { verification_max_age_days: 90, allow_catch_all: false, min_warmup_score: 80, duplicate_company_window_days: 30 },
    windows: {
      priority_days: ["tue", "wed", "thu"],
      secondary_days: ["mon", "fri"],
      window_local: ["08:30", "11:00"],
      secondary_window_local: ["13:30", "16:00"],
      weekend: false,
      jitter_minutes: 17,
    },
    sequence: { touches: stored, setting: { version: 1, value: SEQUENCE } },
  };
  mutate?.(c);
  return c;
}
const refusals = (c: PreflightContext) => preflight(c).verdicts.map((v) => v.reason);

describe("preflight: sequence hash bridge", () => {
  test("a sequence-approved step 1 passes the approval check", () => {
    assert.deepEqual(refusals(preflightCtx(1)), []);
  });
  test("A4: a new email_sequence delay after approval → stale_approval", () => {
    const moved = emailSequenceSchema.parse({ steps: SEQUENCE.steps.map((s) => (s.step_no === 3 ? { ...s, delay: 14 } : s)) });
    assert.ok(refusals(preflightCtx(1, (c) => (c.sequence!.setting = { version: 2, value: moved }))).includes("stale_approval"));
  });
  test("A4: a changed signature after approval → stale_approval", () => {
    assert.ok(refusals(preflightCtx(1, (c) => (c.sender.signature_text = "Amir E."))).includes("stale_approval"));
  });
  test("a step-2 body changed after approval → stale_approval on step 1 too (one hash)", () => {
    assert.ok(
      refusals(preflightCtx(1, (c) => (c.sequence!.touches = c.sequence!.touches.map((t) => (t.step_no === 2 ? { ...t, body: "changed" } : t))))).includes(
        "stale_approval",
      ),
    );
  });
  test("sequence not loaded or a step missing → stale_approval (fail closed)", () => {
    assert.ok(refusals(preflightCtx(1, (c) => (c.sequence = null))).includes("stale_approval"));
    assert.ok(refusals(preflightCtx(1, (c) => (c.sequence!.touches = c.sequence!.touches.slice(0, 2)))).includes("stale_approval"));
  });
  test("a sequence-approved step 2 is never sendable by the engine (null subject ≠ Re: …)", () => {
    const r = refusals(preflightCtx(2));
    assert.ok(r.includes("stale_approval"), r.join(","));
  });
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function cardSteps(bodyWords = 0, claimsPerStep = 0): SequenceCardStep[] {
  const pad = bodyWords > 0 ? ` ${Array.from({ length: bodyWords }, (_, i) => `word${i}`).join(" ")}` : "";
  return [step1(), step2(), step3()].map((s, i) => {
    const extra: Claim[] = Array.from({ length: claimsPerStep }, (_, k) => ({
      span: `claim ${k} ${"long span text ".repeat(8)}`,
      kind: "inference",
      evidence_ids: ["E1", "E2"],
    }));
    return {
      touch_id: `touch-${s.step_no}`,
      step_no: s.step_no,
      source: s.source,
      delay: SEQUENCE.steps[i]!.delay,
      delay_unit: "days",
      offset_days: [0, 7, 14][i]!,
      subject: s.subject,
      body: s.source === "template" ? s.body : s.body.replace("\n\n" + FOOTER, `${pad}\n\n${FOOTER}`),
      claims: s.source === "template" ? [] : [...s.claims, ...extra],
    };
  });
}

const QUAL = {
  fit_score: 70,
  segment: "us-realestate",
  problem_hypothesis: "Test Realty answers every enquiry by hand from one shared team inbox.",
  evidence: EVIDENCE.map((e) => ({ id: e.id, observation: `${e.observation} ${"more evidence text ".repeat(6)}` })),
  recommended_angle: "speed-to-lead",
  evidence_fetched_at: daysAgo(5),
  evidence_policy_version: 1,
  max_age_days: 30,
};
const LEAD_CARD = { id: "lead-1", first_name: "Pat", last_name: "Fixture", title: "Broker", email_status: "valid" };
const COMPANY = { name: "Test Realty", domain: "test.example" };

describe("sequence card (09 §U6c scope 2)", () => {
  test("shows every step, '+7 days · same thread', the quote line, claims with evidence id + date", () => {
    const [card] = formatSequenceApprovalMessages({ steps: cardSteps(), sequence_setting_version: 1 }, LEAD_CARD, QUAL, COMPANY, NOW);
    assert.ok(card);
    assert.match(card, /STEP 1 · day 0/);
    assert.match(card, /STEP 2 · \+7 days · same thread/);
    assert.match(card, /STEP 3 · \+7 days · same thread/);
    assert.equal(card.match(/Instantly adds a quote of step 1 below\./g)?.length, 2);
    assert.match(card, new RegExp(`Re: ${SUBJECT}`));
    assert.match(card, /← E1 · \d{4}-\d{2}-\d{2}/);
    assert.match(card, /freshness: 5d \+ 7d ≤ 30d/);
    assert.match(card, /template · cites no evidence/);
    assert.match(card, /I haven&#x27;t heard back|I haven't heard back/);
  });
  test("worst case (120-word bodies, many long claims) still fits in ONE message ≤ 4096", () => {
    const msgs = formatSequenceApprovalMessages({ steps: cardSteps(95, 6), sequence_setting_version: 1 }, LEAD_CARD, QUAL, COMPANY, NOW);
    assert.equal(msgs.length, 1);
    assert.ok(telegramVisibleLength(msgs[0]!) <= TELEGRAM_TEXT_LIMIT, String(telegramVisibleLength(msgs[0]!)));
    // Bodies are never truncated.
    assert.ok(msgs[0]!.includes("word94"));
  });
  test("buttons: approve all, one edit per step, kill, snooze", () => {
    const b = sequenceApprovalButtons(cardSteps().map((s) => ({ step_no: s.step_no, touch_id: s.touch_id })));
    assert.equal(b[0]![0]!.text, "✅ Approve all 3");
    assert.equal(b[0]![0]!.callback_data, "approve:touch-1");
    assert.deepEqual(b[1]!.map((x) => x.callback_data), ["edit:touch-1", "edit:touch-2", "edit:touch-3"]);
    assert.deepEqual(b[2]!.map((x) => x.callback_data), ["kill:touch-1", "snooze:touch-1"]);
  });
});
