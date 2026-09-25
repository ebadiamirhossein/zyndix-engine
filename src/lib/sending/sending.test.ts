import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  approvalHash,
  buildApprovalSnapshot,
  canonicalJson,
  composeOutboundBody,
  findSignOff,
  normalizeSignature,
  sendIdempotencyKey,
} from "./approval";
import { ALLOWED_SENDER_DOMAINS, checkSenderDomain, normalizeDomain } from "./guard";
import { preflight, threadedSubject, type PreflightContext } from "./preflight";
import { isEligibleSender, pickLeastLoaded, type SenderCandidate } from "./sender";
import { resolveRecipientTimezone, singleTimezoneForCountry } from "./timezone";
import { normalizeUsState, resolveUsTimezone, SINGLE_ZONE_STATES, SPLIT_STATE_CITIES } from "./us-timezones";
import { PREFLIGHT_REFUSALS, type PreflightRefusal } from "@/types/enums";

// Pure suite for U5's guard, approval binding, timezone resolution and
// preflight (09 §U5 DoD). No DB, no network.

// Tue 2026-09-29 09:00 Europe/Vilnius (UTC+3) — inside the priority window.
const INSIDE = new Date("2026-09-29T06:00:00.000Z");
// Sat 2026-10-03 12:00 Vilnius — no window on a weekend.
const WEEKEND = new Date("2026-10-03T09:00:00.000Z");

const WINDOWS = {
  priority_days: ["tue", "wed", "thu"],
  secondary_days: ["mon", "fri"],
  window_local: ["08:30", "11:00"] as [string, string],
  secondary_window_local: ["13:30", "16:00"] as [string, string],
  weekend: false,
  jitter_minutes: 17,
};
const POLICY = {
  verification_max_age_days: 90,
  allow_catch_all: false,
  min_warmup_score: 80,
  duplicate_company_window_days: 30,
};

const SIGNATURE = "Amir Ebadi\nZyndix, Vilnius\nzyndix.com";
const SENDER = {
  id: "acct-zyndixhq-amir",
  identifier: "amir@zyndixhq.com",
  health: "ok",
  instantly_campaign_id: "camp-1",
  signature_text: SIGNATURE as string | null,
};

function base(): PreflightContext {
  const touch = {
    id: "touch-1",
    step_no: 1,
    channel: "email",
    direction: "outbound",
    status: "approved",
    subject: "Your listing pages",
    body: "Hi Test,\n\nA specific observation.\n\nWant the three?",
    prompt_version: 7,
    approval_hash: null as string | null,
  };
  const lead = {
    id: "lead-1",
    state: "approved" as const,
    email: "test.lead@target.example.invalid",
    email_status: "valid",
    email_verified_at: "2026-09-20T00:00:00.000Z",
    timezone: "Europe/Vilnius",
    do_not_contact: false,
    send_account_id: null as string | null,
  };
  touch.approval_hash = approvalHash(buildApprovalSnapshot(touch, lead, SENDER));
  return {
    now: INSIDE,
    touch,
    lead,
    company: { domain: "target.example.invalid", timezone: null, country: "LT" },
    sender: { ...SENDER },
    providerHealth: { verdict: "healthy", warmupScore: 100 },
    suppression: { email: false, domain: false },
    hasReply: false,
    companyConflicts: 0,
    capacityRemaining: 15,
    threadAnchor: null,
    policy: { ...POLICY },
    windows: WINDOWS,
  };
}

const reasons = (ctx: PreflightContext): PreflightRefusal[] => preflight(ctx).verdicts.map((v) => v.reason);

describe("09 §U5 DoD — preflight table (exact reason strings)", () => {
  const cases: Array<[PreflightRefusal | "ok", (c: PreflightContext) => void]> = [
    ["ok", () => {}],
    ["suppressed_email", (c) => (c.suppression.email = true)],
    ["suppressed_domain", (c) => (c.suppression.domain = true)],
    ["reply_freeze", (c) => (c.hasReply = true)],
    ["booking_hold", (c) => (c.lead.state = "meeting_booked")],
    ["manual_hold", (c) => (c.lead.state = "manual_hold")],
    ["email_unverified", (c) => (c.lead.email_status = "unverified")],
    ["email_invalid", (c) => (c.lead.email_status = "invalid")],
    ["sender_unhealthy", (c) => (c.providerHealth = { verdict: "unknown", warmupScore: null })],
    ["quota_exhausted", (c) => (c.capacityRemaining = 0)],
    ["outside_window", (c) => (c.now = WEEKEND)],
    ["duplicate_company_active", (c) => (c.companyConflicts = 1)],
    ["stale_approval", (c) => (c.touch.body = `${c.touch.body} (edited after approval)`)],
    ["blocked_sender_domain", (c) => (c.sender.identifier = "amir@zyndix.com")],
    ["sender_mismatch", (c) => (c.lead.send_account_id = "acct-getzyndix-amir")],
  ];
  assert.equal(cases.length, 15);
  for (const [expected, mutate] of cases) {
    test(`${expected}`, () => {
      const ctx = base();
      mutate(ctx);
      const got = reasons(ctx);
      if (expected === "ok") {
        assert.deepEqual(got, []);
        assert.equal(preflight(ctx).ok, true);
      } else {
        assert.deepEqual(got, [expected]);
      }
    });
  }
});

describe("preflight extras and policy detail", () => {
  test("sender outside the allow-list → sender_not_allowed", () => {
    const ctx = base();
    ctx.sender.identifier = "amir@example.com";
    assert.deepEqual(reasons(ctx), ["sender_not_allowed"]);
  });
  test("lead not yet approved → lead_state_invalid", () => {
    const ctx = base();
    ctx.lead.state = "pending_approval";
    assert.deepEqual(reasons(ctx), ["lead_state_invalid"]);
  });
  test("non-email channel → channel_unsupported", () => {
    const ctx = base();
    ctx.touch.channel = "linkedin_msg";
    assert.ok(reasons(ctx).includes("channel_unsupported"));
  });
  test("recipient changed after approval → stale_approval", () => {
    const ctx = base();
    ctx.lead.email = "someone.else@target.example.invalid";
    assert.deepEqual(reasons(ctx), ["stale_approval"]);
  });
  test("touch not in approved status → stale_approval", () => {
    const ctx = base();
    ctx.touch.status = "pending_approval";
    assert.deepEqual(reasons(ctx), ["stale_approval"]);
  });
  test("catch_all refused unless the policy allows it", () => {
    const ctx = base();
    ctx.lead.email_status = "catch_all";
    assert.deepEqual(reasons(ctx), ["email_unverified"]);
    ctx.policy.allow_catch_all = true;
    assert.deepEqual(reasons(ctx), []);
  });
  test("verification older than the policy max age → email_unverified", () => {
    const ctx = base();
    ctx.lead.email_verified_at = "2026-01-01T00:00:00.000Z";
    assert.deepEqual(reasons(ctx), ["email_unverified"]);
  });
  test("do_not_contact → suppressed_email", () => {
    const ctx = base();
    ctx.lead.do_not_contact = true;
    assert.deepEqual(reasons(ctx), ["suppressed_email"]);
  });
  test("warmup score below policy, paused account, missing campaign → sender_unhealthy with every reason", () => {
    const ctx = base();
    ctx.providerHealth = { verdict: "healthy", warmupScore: 50 };
    ctx.sender.health = "paused";
    ctx.sender.instantly_campaign_id = null;
    const result = preflight(ctx);
    assert.deepEqual(result.verdicts.map((v) => v.reason), ["sender_unhealthy"]);
    assert.deepEqual(result.verdicts[0].detail?.reasons, [
      "send_accounts.health=paused",
      "warmup_score=50<80",
      "no_instantly_campaign",
    ]);
  });
  test("every failing rule is reported, in PREFLIGHT_REFUSALS order", () => {
    const ctx = base();
    ctx.now = WEEKEND;
    ctx.suppression.domain = true;
    ctx.sender.identifier = "x@mail.zyndix.com";
    const got = reasons(ctx);
    assert.deepEqual(got, ["blocked_sender_domain", "suppressed_domain", "outside_window"]);
    const idx = got.map((r) => PREFLIGHT_REFUSALS.indexOf(r));
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  });
});

describe("sender pinning", () => {
  test("bound to amir@zyndixhq, follow-up routed to amir@getzyndix → sender_mismatch", () => {
    const ctx = base();
    ctx.lead.state = "sent";
    ctx.lead.send_account_id = "acct-zyndixhq-amir";
    ctx.touch.step_no = 2;
    ctx.touch.subject = threadedSubject("Your listing pages");
    ctx.sender = {
      id: "acct-getzyndix-amir",
      identifier: "amir@getzyndix.com",
      health: "ok",
      instantly_campaign_id: "camp-2",
      signature_text: SIGNATURE,
    };
    // Approved for the other mailbox, so only the pinning rule fails.
    ctx.touch.approval_hash = approvalHash(buildApprovalSnapshot(ctx.touch, ctx.lead, ctx.sender));
    ctx.threadAnchor = { emailId: "email-1", subject: "Your listing pages" };
    assert.deepEqual(reasons(ctx), ["sender_mismatch"]);
  });
  test("same bound sender on the follow-up → ok", () => {
    const ctx = base();
    ctx.lead.state = "sent";
    ctx.lead.send_account_id = SENDER.id;
    ctx.touch.step_no = 2;
    ctx.touch.subject = threadedSubject("Your listing pages");
    ctx.touch.approval_hash = approvalHash(buildApprovalSnapshot(ctx.touch, ctx.lead, ctx.sender));
    ctx.threadAnchor = { emailId: "email-1", subject: "Your listing pages" };
    assert.deepEqual(reasons(ctx), []);
  });
  test("follow-up with no step-1 email to reply to → thread_anchor_missing", () => {
    const ctx = base();
    ctx.lead.state = "sent";
    ctx.lead.send_account_id = SENDER.id;
    ctx.touch.step_no = 2;
    ctx.touch.subject = "Re: Your listing pages";
    ctx.touch.approval_hash = approvalHash(buildApprovalSnapshot(ctx.touch, ctx.lead, ctx.sender));
    assert.deepEqual(reasons(ctx), ["thread_anchor_missing"]);
  });
  test("follow-up whose subject is not Re: <step-1 subject> → stale_approval", () => {
    const ctx = base();
    ctx.lead.state = "sent";
    ctx.lead.send_account_id = SENDER.id;
    ctx.touch.step_no = 2;
    ctx.touch.subject = "A brand new subject";
    ctx.touch.approval_hash = approvalHash(buildApprovalSnapshot(ctx.touch, ctx.lead, ctx.sender));
    ctx.threadAnchor = { emailId: "email-1", subject: "Your listing pages" };
    assert.deepEqual(reasons(ctx), ["stale_approval"]);
  });
  test("threadedSubject does not stack prefixes", () => {
    assert.equal(threadedSubject("Hello"), "Re: Hello");
    assert.equal(threadedSubject("RE: Hello"), "RE: Hello");
  });
});

describe("timezone resolution (operator rule, Session 11)", () => {
  test("(a) lead + company timezone null, single-zone country → country_fallback, not refused", () => {
    const ctx = base();
    ctx.lead.timezone = null;
    ctx.company = { domain: "target.example.invalid", timezone: null, country: "LT" };
    const result = preflight(ctx);
    assert.deepEqual(result.verdicts, []);
    assert.deepEqual(result.timezone, { timeZone: "Europe/Vilnius", source: "country_fallback", country: "LT" });
  });
  test("(a') the country may be an English name", () => {
    assert.deepEqual(singleTimezoneForCountry("Lithuania"), { code: "LT", timeZone: "Europe/Vilnius" });
    assert.deepEqual(singleTimezoneForCountry("United Kingdom"), { code: "GB", timeZone: "Europe/London" });
    assert.deepEqual(singleTimezoneForCountry(" uk "), { code: "GB", timeZone: "Europe/London" });
  });
  test("(b) multi-zone country (US) → timezone_unknown, never outside_window", () => {
    const ctx = base();
    ctx.lead.timezone = null;
    ctx.company = { domain: "target.example.invalid", timezone: null, country: "US" };
    const got = reasons(ctx);
    assert.deepEqual(got, ["timezone_unknown"]);
    assert.ok(!got.includes("outside_window"));
    assert.equal(preflight(ctx).window, null);
  });
  test("(b) null country → timezone_unknown, even at a weekend instant", () => {
    const ctx = base();
    ctx.now = WEEKEND;
    ctx.lead.timezone = null;
    ctx.company = { domain: "target.example.invalid", timezone: null, country: null };
    assert.deepEqual(reasons(ctx), ["timezone_unknown"]);
  });
  test("strict single-zone rule: DE, ES, PT, CY, CA, AU, BR are not fallbacks", () => {
    for (const code of ["DE", "ES", "PT", "CY", "CA", "AU", "BR", "US", "RU", "MX"]) {
      assert.equal(singleTimezoneForCountry(code), null, code);
    }
  });
  test("lead timezone wins over company, company over country; an invalid zone is skipped", () => {
    assert.equal(
      resolveRecipientTimezone({ leadTimezone: "America/Chicago", companyTimezone: "Europe/London", companyCountry: "LT" })?.source,
      "lead",
    );
    assert.equal(
      resolveRecipientTimezone({ leadTimezone: null, companyTimezone: "Europe/London", companyCountry: "LT" })?.source,
      "company",
    );
    assert.equal(
      resolveRecipientTimezone({ leadTimezone: "Not/AZone", companyTimezone: null, companyCountry: "LT" })?.source,
      "country_fallback",
    );
  });
});

describe("09 §U5 DoD — domain guard sub-table", () => {
  for (const value of ["zyndix.com", "mail.zyndix.com", "ZYNDIX.COM", "zyndix.com.", "a.b.zyndix.com", " zyndix.com "]) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      const verdict = checkSenderDomain(value);
      assert.equal(verdict.ok, false);
      assert.equal(verdict.ok ? null : verdict.reason, "blocked_sender_domain");
    });
  }
  for (const value of ["zyndixhq.com", "getzyndix.com", "amir@zyndixhq.com", "INGRIDA@GetZyndix.com."]) {
    test(`accepts ${JSON.stringify(value)}`, () => {
      assert.equal(checkSenderDomain(value).ok, true);
    });
  }
  test("an address at zyndix.com is blocked, and lookalikes are not allowed", () => {
    assert.deepEqual(checkSenderDomain("amir@zyndix.com"), { ok: false, reason: "blocked_sender_domain", domain: "zyndix.com" });
    assert.equal(checkSenderDomain("notzyndix.com").ok ? "ok" : "refused", "refused");
    assert.equal(checkSenderDomain("mail.zyndixhq.com").ok, false);
  });
  test("the allow-list holds exactly the two purchased domains and never zyndix.com", () => {
    assert.deepEqual([...ALLOWED_SENDER_DOMAINS].sort(), ["getzyndix.com", "zyndixhq.com"]);
    assert.equal(normalizeDomain(" Zyndix.COM.. "), "zyndix.com");
  });
});

describe("approval binding", () => {
  test("hash is stable across key order and changes with any bound field", () => {
    const ctx = base();
    const snap = buildApprovalSnapshot(ctx.touch, ctx.lead, ctx.sender);
    const reordered = Object.fromEntries(Object.entries(snap).reverse()) as typeof snap;
    assert.equal(approvalHash(snap), approvalHash(reordered));
    for (const field of ["recipient", "subject", "body", "channel", "signature", "send_account_id"] as const) {
      assert.notEqual(approvalHash({ ...snap, [field]: `${snap[field]}x` }), approvalHash(snap), field);
    }
    assert.notEqual(approvalHash({ ...snap, step_no: 2 }), approvalHash(snap));
  });
  test("the claim ledger is bound: a changed or dropped ledger is stale_approval (09 §U6b)", () => {
    const ctx = base();
    const ledger = [{ span: "A specific observation", kind: "prospect_fact", evidence_ids: ["E1"] }];
    ctx.touch.claim_ledger = ledger;
    ctx.touch.approval_hash = approvalHash(buildApprovalSnapshot(ctx.touch, ctx.lead, ctx.sender));
    assert.deepEqual(reasons(ctx), []);
    const snap = buildApprovalSnapshot(ctx.touch, ctx.lead, ctx.sender);
    assert.deepEqual(snap.claim_ledger, ledger);
    ctx.touch.claim_ledger = [{ ...ledger[0], evidence_ids: ["E2"] }];
    assert.deepEqual(reasons(ctx), ["stale_approval"]);
    ctx.touch.claim_ledger = null;
    assert.deepEqual(reasons(ctx), ["stale_approval"]);
  });
  test("recipient comparison is case-insensitive; canonicalJson sorts keys", () => {
    const ctx = base();
    const a = buildApprovalSnapshot(ctx.touch, { ...ctx.lead, email: "Test.Lead@Target.example.invalid " }, ctx.sender);
    assert.equal(approvalHash(a), ctx.touch.approval_hash);
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] }), '{"a":[2,{"c":0,"d":1}],"b":1}');
  });
  test("idempotency key names the touch and the approved version", () => {
    assert.equal(sendIdempotencyKey("t1", "abc"), "send:t1:abc");
  });
});

describe("signature bound into the approval (Session 12)", () => {
  test("the snapshot carries the sender and its signature", () => {
    const ctx = base();
    const snap = buildApprovalSnapshot(ctx.touch, ctx.lead, ctx.sender);
    assert.equal(snap.send_account_id, SENDER.id);
    assert.equal(snap.signature, SIGNATURE);
  });
  test("signature edited after approval → stale_approval", () => {
    const ctx = base();
    ctx.sender.signature_text = "Amir Ebadi\nZyndix\nzyndix.com";
    assert.deepEqual(reasons(ctx), ["stale_approval"]);
  });
  test("approved for one mailbox, dispatched from another (unbound lead) → stale_approval", () => {
    const ctx = base();
    ctx.sender = { ...SENDER, id: "acct-getzyndix-amir", identifier: "amir@getzyndix.com" };
    assert.deepEqual(reasons(ctx), ["stale_approval"]);
  });
  test("no signature on the sender → sender_signature_missing (and the pre-signature hash is stale)", () => {
    const ctx = base();
    ctx.sender.signature_text = "   ";
    ctx.touch.approval_hash = approvalHash(buildApprovalSnapshot(ctx.touch, ctx.lead, ctx.sender));
    assert.deepEqual(reasons(ctx), ["sender_signature_missing"]);
  });
  test("a touch approved before signatures existed (U5 snapshot) is stale", () => {
    const ctx = base();
    const legacy = { ...buildApprovalSnapshot(ctx.touch, ctx.lead, ctx.sender) } as Record<string, unknown>;
    delete legacy.send_account_id;
    delete legacy.signature;
    ctx.touch.approval_hash = approvalHash(legacy as unknown as ReturnType<typeof buildApprovalSnapshot>);
    assert.ok(reasons(ctx).includes("stale_approval"));
  });
  test("composeOutboundBody: signature goes right before the compliance footer (operator, Session 12)", () => {
    const footer = "Zyndix, MB · Gerosios Vilties g. 6-76, Vilnius, Lithuania\nNot useful? Reply STOP and I won't write again.";
    assert.equal(
      composeOutboundBody(`Hi Test,\n\nWant me to send them over?\n\n${footer}`, SIGNATURE),
      `Hi Test,\n\nWant me to send them over?\n\n${SIGNATURE}\n\n${footer}`,
    );
  });
  test("findSignOff: '— Amir' and 'Best,\\nAmir' are sign-offs; bullets and sentences are not", () => {
    assert.equal(findSignOff("Hi,\n\nText.\n\n— Amir\nZyndix, MB · Vilnius\nNot useful? Reply STOP"), "— Amir");
    assert.equal(findSignOff("Hi,\n\nText.\n\nBest,\nAmir Ebadi"), "Best,\nAmir Ebadi");
    assert.equal(findSignOff("Hi,\n- Faster intake\n- Fewer misses\n\n-- \nnot a name"), null);
    assert.equal(findSignOff("Thanks,\nwould that help"), null);
    assert.equal(findSignOff("Hi — the team handles it.\n\nZyndix, MB\nNot useful? Reply STOP"), null);
  });
  test("composeOutboundBody: body, one blank line, signature; trailing space trimmed", () => {
    assert.equal(composeOutboundBody("Hi,\n\nThanks.\n\n  ", SIGNATURE), `Hi,\n\nThanks.\n\n${SIGNATURE}`);
    assert.equal(composeOutboundBody("Hi", null), "Hi");
    assert.equal(normalizeSignature(" a\r\nb \n"), "a\nb");
  });
});

describe("sender assignment at approval (Session 12)", () => {
  const acct = (id: string, identifier: string, extra: Partial<SenderCandidate> = {}): SenderCandidate => ({
    id,
    identifier,
    kind: "email",
    health: "ok",
    instantly_campaign_id: `camp-${id}`,
    signature_text: SIGNATURE,
    ...extra,
  });
  test("least loaded eligible account wins; ties go to identifier order", () => {
    const a = acct("a", "amir@zyndixhq.com");
    const b = acct("b", "amir@getzyndix.com");
    const c = acct("c", "ingrida@getzyndix.com");
    assert.equal(pickLeastLoaded([a, b, c], new Map())?.id, "b");
    assert.equal(pickLeastLoaded([a, b, c], new Map([["b", 2], ["c", 1]]))?.id, "a");
  });
  test("send_policy.assignable_senders restricts the pool (amir@ only), case-insensitively", () => {
    const a = acct("a", "amir@zyndixhq.com");
    const b = acct("b", "amir@getzyndix.com");
    const i = acct("i", "ingrida@getzyndix.com");
    const only = ["AMIR@zyndixhq.com", "amir@getzyndix.com"];
    assert.equal(pickLeastLoaded([i, a, b], new Map([["a", 3], ["b", 2]]), only)?.id, "b");
    assert.equal(pickLeastLoaded([i], new Map(), only), null);
    assert.equal(pickLeastLoaded([i, a], new Map([["a", 5]]))?.id, "i");
  });
  test("ineligible: paused, no campaign, no signature, zyndix.com, non-email", () => {
    assert.equal(isEligibleSender(acct("1", "amir@zyndixhq.com", { health: "paused" })), false);
    assert.equal(isEligibleSender(acct("2", "amir@zyndixhq.com", { instantly_campaign_id: null })), false);
    assert.equal(isEligibleSender(acct("3", "amir@zyndixhq.com", { signature_text: " " })), false);
    assert.equal(isEligibleSender(acct("4", "amir@zyndix.com")), false);
    assert.equal(isEligibleSender(acct("5", "amir@zyndixhq.com", { kind: "linkedin" })), false);
    assert.equal(pickLeastLoaded([acct("4", "amir@zyndix.com")], new Map()), null);
  });
});

describe("US HQ-state timezone (Session 12)", () => {
  test("single-zone states by code or name", () => {
    assert.deepEqual(resolveUsTimezone({ state: "Colorado", city: null }), { ok: true, timeZone: "America/Denver", source: "hq_state", state: "CO" });
    assert.deepEqual(resolveUsTimezone({ state: "ny", city: "" }), { ok: true, timeZone: "America/New_York", source: "hq_state", state: "NY" });
    assert.equal(normalizeUsState("District of Columbia"), "DC");
    assert.equal(normalizeUsState("Washington, D.C."), "DC");
  });
  test("Arizona is Phoenix, except Navajo Nation communities", () => {
    assert.equal((resolveUsTimezone({ state: "AZ", city: "Scottsdale" }) as { timeZone: string }).timeZone, "America/Phoenix");
    assert.equal((resolveUsTimezone({ state: "AZ", city: "Window Rock" }) as { timeZone: string }).timeZone, "America/Denver");
  });
  test("split state resolves only from a listed city, on either side of the line", () => {
    assert.deepEqual(resolveUsTimezone({ state: "Texas", city: "Austin" }), { ok: true, timeZone: "America/Chicago", source: "hq_state_city", state: "TX" });
    assert.deepEqual(resolveUsTimezone({ state: "TX", city: "El Paso" }), { ok: true, timeZone: "America/Denver", source: "hq_state_city", state: "TX" });
    assert.equal((resolveUsTimezone({ state: "Tennessee", city: "Nashville" }) as { timeZone: string }).timeZone, "America/Chicago");
    assert.equal((resolveUsTimezone({ state: "Tennessee", city: "Knoxville" }) as { timeZone: string }).timeZone, "America/New_York");
    assert.equal((resolveUsTimezone({ state: "FL", city: "Pensacola" }) as { timeZone: string }).timeZone, "America/Chicago");
    assert.equal((resolveUsTimezone({ state: "FL", city: "St. Petersburg" }) as { timeZone: string }).timeZone, "America/New_York");
  });
  test("split state with no city, or an unlisted city → ambiguous, never the majority zone", () => {
    assert.deepEqual(resolveUsTimezone({ state: "Texas", city: null }), { ok: false, unresolved: "ambiguous_split_state", state: "TX" });
    assert.deepEqual(resolveUsTimezone({ state: "FL", city: "Smallville" }), { ok: false, unresolved: "ambiguous_split_state", state: "FL" });
  });
  test("missing or unknown state → unresolved", () => {
    assert.deepEqual(resolveUsTimezone({ state: null, city: "Austin" }), { ok: false, unresolved: "state_missing", state: null });
    assert.deepEqual(resolveUsTimezone({ state: "Ontario", city: "Toronto" }), { ok: false, unresolved: "state_unknown", state: "Ontario" });
  });
  test("every zone in the tables is a valid IANA zone, and no city is listed on both sides", () => {
    const zones = new Set([...Object.values(SINGLE_ZONE_STATES), ...Object.values(SPLIT_STATE_CITIES).flatMap((z) => Object.keys(z))]);
    for (const tz of zones) assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: tz }), tz);
    for (const [state, sides] of Object.entries(SPLIT_STATE_CITIES)) {
      const all = Object.values(sides).flat();
      assert.equal(new Set(all).size, all.length, `${state} lists a city twice`);
      assert.ok(!(state in SINGLE_ZONE_STATES), `${state} is both single and split`);
    }
  });
});
