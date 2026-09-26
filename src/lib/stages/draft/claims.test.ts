// Claim guard unit tests (09 §U6b). Pure: no DB, no network, synthetic data.
// Run: pnpm test:claims
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Claim } from "@/lib/validation/llm";
import { writerOutputSchema } from "@/lib/validation/llm";

import {
  checkClaims,
  claimsStillPresent,
  detectContradictions,
  splitComplianceFooter,
  type ClaimCheckInput,
  type ClaimEvidence,
  type ClaimReason,
} from "./claims";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const APPROVED = "Happy to write up what I'd change, if that's useful.";
const FOOTER = "Zyndix, MB · Gerosios Vilties g. 6-76, Vilnius, Lithuania\nNot useful? Reply STOP and I won't write again.";

const EVIDENCE: ClaimEvidence[] = [
  { id: "E1", source: "website", observation: "Contact section is a bare name/email form plus phone number, with no scheduling link visible." },
  { id: "E2", source: "website", observation: "'20+ Years Serving Houston, TX and now also serving East TX' — expansion to a second market." },
  { id: "E3", source: "apollo", observation: "Title is 'Owner/Broker' — Enrique is the decision-maker." },
];
const SITE = "Home | Acme Test Realty\n20+ Years Serving Houston, TX and now also serving East TX\nCall or Email anytime";

const CLEAN_SUBJECT = "Houston and East TX inquiries";
const CLEAN_BODY = [
  "Hi Enrique,",
  "",
  "You've been serving Houston, TX for 20+ years and now East TX too. With a second market, every inquiry still lands on the same contact form and phone line, so response speed depends on who is free.",
  APPROVED,
].join("\n");
const CLEAN_CLAIMS: Claim[] = [
  { span: "Houston and East TX inquiries", kind: "inference", evidence_ids: ["E2"] },
  { span: "You've been serving Houston, TX for 20+ years and now East TX too", kind: "prospect_fact", evidence_ids: ["E2"] },
  { span: "every inquiry still lands on the same contact form and phone line", kind: "inference", evidence_ids: ["E1"] },
  { span: APPROVED, kind: "offer", evidence_ids: [] },
];

function input(over: Partial<ClaimCheckInput> = {}): ClaimCheckInput {
  const evidence = over.evidence ?? EVIDENCE;
  const siteText = over.siteText === undefined ? SITE : over.siteText;
  return {
    subject: CLEAN_SUBJECT,
    body: CLEAN_BODY,
    claims: CLEAN_CLAIMS,
    evidence,
    siteText,
    evidenceFetchedAt: daysAgo(3),
    now: NOW,
    maxAgeDays: 30,
    approvedOfferLines: [APPROVED],
    proofPoint: null,
    allowNames: ["Enrique", "Testov", "Acme Test Realty", "acme-test.example", "Zyndix"],
    visibleTools: [],
    contradictions: detectContradictions({ evidence, techSignals: { hasChatWidget: false }, siteText }),
    contextTexts: ["Owner-run brokerage expanding to a second market answers inquiries by hand."],
    ...over,
  };
}

function reasons(i: ClaimCheckInput): ClaimReason[] {
  const r = checkClaims(i);
  return r.ok ? [] : [...new Set(r.violations.map((v) => v.reason))];
}

function violations(i: ClaimCheckInput) {
  const r = checkClaims(i);
  return r.ok ? [] : r.violations;
}

/** Replace the clean middle sentence with `sentence`, adding `claims`. */
function withSentence(sentence: string, extra: Claim[] = []): Partial<ClaimCheckInput> {
  return {
    body: ["Hi Enrique,", "", `You've been serving Houston, TX for 20+ years and now East TX too. ${sentence}`, APPROVED].join("\n"),
    claims: [CLEAN_CLAIMS[0]!, CLEAN_CLAIMS[1]!, CLEAN_CLAIMS[3]!, ...extra],
  };
}

describe("clean draft", () => {
  test("DoD 9: a clean draft passes", () => {
    assert.deepEqual(violations(input()), []);
  });
  test("the compliance footer is stripped before checking (its address is not a fact)", () => {
    const { content, hadFooter } = splitComplianceFooter(`${CLEAN_BODY}\n\n${FOOTER}`, FOOTER);
    assert.equal(hadFooter, true);
    assert.equal(content, CLEAN_BODY);
    assert.deepEqual(reasons(input({ body: content })), []);
  });
  test("an unstripped footer fails closed as uncovered facts", () => {
    assert.ok(reasons(input({ body: `${CLEAN_BODY}\n\n${FOOTER}` })).includes("uncovered_fact"));
  });
  test("writer schema: claims required; prospect_fact needs ids; offer cites none", () => {
    assert.equal(writerOutputSchema.safeParse({ subject: "s", body: "b" }).success, false);
    assert.equal(writerOutputSchema.safeParse({ subject: "s", body: "b", claims: [{ span: "b", kind: "prospect_fact", evidence_ids: [] }] }).success, false);
    assert.equal(writerOutputSchema.safeParse({ subject: "s", body: "b", claims: [{ span: "b", kind: "offer", evidence_ids: ["E1"] }] }).success, false);
    assert.equal(writerOutputSchema.safeParse({ subject: "s", body: "b", claims: [{ span: "b", kind: "inference", evidence_ids: ["1"] }] }).success, false);
    assert.equal(writerOutputSchema.safeParse({ subject: CLEAN_SUBJECT, body: CLEAN_BODY, claims: CLEAN_CLAIMS }).success, true);
  });
});

describe("audit pattern 1 — invented timing (DoD 1)", () => {
  test('"9pm on a Saturday … until Monday" → invented_timing', () => {
    const v = violations(input(withSentence("A buyer who messages at 9pm on a Saturday waits until Monday.")));
    assert.ok(v.some((x) => x.reason === "invented_timing" && x.token === "9pm"));
    assert.ok(v.some((x) => x.reason === "invented_timing" && x.token === "Saturday"));
    assert.ok(v.some((x) => x.reason === "invented_timing" && x.token === "Monday"));
  });
  test("tagging the timing as a prospect_fact does not help without evidence", () => {
    const s = "Inquiries sent on a Tuesday evening sit overnight";
    assert.ok(reasons(input(withSentence(`${s}.`, [{ span: s, kind: "prospect_fact", evidence_ids: ["E1"] }]))).includes("invented_timing"));
  });
  test("published office hours cited by a prospect_fact pass", () => {
    const ev = [...EVIDENCE, { id: "E4", source: "website", observation: "Contact page: 'Office open Saturday until noon'." }];
    const s = "your office is open Saturday until noon";
    const i = input({ evidence: ev, siteText: `${SITE}\nOffice open Saturday until noon`, ...withSentence(`I saw ${s}.`, [{ span: s, kind: "prospect_fact", evidence_ids: ["E4"] }]) });
    assert.deepEqual(reasons(i), []);
  });
});

describe("audit pattern 2 — invented place (DoD 6)", () => {
  test('"Beaumont" in no evidence → uncovered_fact', () => {
    const v = violations(input(withSentence("Buyers in Beaumont get the same slow path.")));
    assert.ok(v.some((x) => x.reason === "uncovered_fact" && x.token === "Beaumont"));
  });
  test('"Beaumont" wrapped in an inference claim → unsupported_prospect_fact', () => {
    const s = "Buyers in Beaumont get the same slow path";
    const v = violations(input(withSentence(`${s}.`, [{ span: s, kind: "inference", evidence_ids: ["E2"] }])));
    assert.ok(v.some((x) => x.reason === "unsupported_prospect_fact" && x.token === "Beaumont"));
  });
  test("a sentence-initial common word is not a proper noun", () => {
    const s = "Buyers who reach out get one path";
    assert.deepEqual(reasons(input(withSentence(`${s}.`))), []);
  });
});

describe("audit pattern 3 — unbacked asset (DoD 2)", () => {
  test('"I\'ve mapped out a few fixes" → unbacked_asset_claim', () => {
    assert.ok(reasons(input(withSentence("I've mapped out a few specific fixes."))).includes("unbacked_asset_claim"));
  });
  test('"I mapped out three specific fixes" (Stride) → unbacked_asset_claim and the number is caught', () => {
    const r = reasons(input(withSentence("I mapped out three specific fixes.")));
    assert.ok(r.includes("unbacked_asset_claim"));
    assert.ok(r.includes("uncovered_fact"));
  });
  test('"I put together" / "I\'ve prepared" / "we built" are refused', () => {
    for (const s of ["I put together a short plan.", "I've prepared a checklist for you.", "We built a routing layer for this."]) {
      assert.ok(reasons(input(withSentence(s))).includes("unbacked_asset_claim"), s);
    }
  });
});

describe("audit pattern 4 — stale evidence (DoD 4)", () => {
  test("fetched 31 days ago → stale_evidence", () => {
    assert.deepEqual(reasons(input({ evidenceFetchedAt: daysAgo(31) })), ["stale_evidence"]);
  });
  test("fetched 29 days ago → passes", () => {
    assert.deepEqual(reasons(input({ evidenceFetchedAt: daysAgo(29) })), []);
  });
  test("the limit comes from the setting (max_age_days)", () => {
    assert.deepEqual(reasons(input({ evidenceFetchedAt: daysAgo(29), maxAgeDays: 14 })), ["stale_evidence"]);
  });
  test("unknown fetch date → stale_evidence", () => {
    assert.deepEqual(reasons(input({ evidenceFetchedAt: null })), ["stale_evidence"]);
  });
  test("the 2026-07-13 crawl is refused on 2026-09-25", () => {
    const v = violations(input({ evidenceFetchedAt: "2026-07-13T19:07:38.762Z" }));
    assert.equal(v[0]?.reason, "stale_evidence");
    assert.match(v[0]!.detail, /evidence fetched 2026-07-13, 73 days old \(max 30\)/);
  });
});

describe("offers (DoD 3)", () => {
  test("an offer claim that is not the approved line → unapproved_offer", () => {
    const body = CLEAN_BODY.replace(APPROVED, "I can set up an instant reply system for you.");
    const claims = [...CLEAN_CLAIMS.slice(0, 3), { span: "I can set up an instant reply system for you.", kind: "offer" as const, evidence_ids: [] }];
    assert.deepEqual(reasons(input({ body, claims })), ["unapproved_offer"]);
  });
  test("offer language outside every offer claim → unapproved_offer", () => {
    assert.ok(reasons(input(withSentence("We could fix this quickly."))).includes("unapproved_offer"));
  });
  test("offer language mis-tagged as an inference is still an unapproved offer", () => {
    const s = "Want me to send a quick teardown";
    assert.ok(reasons(input(withSentence(`${s}?`, [{ span: s, kind: "inference", evidence_ids: ["E1"] }]))).includes("unapproved_offer"));
  });
  test("the approved line matches regardless of curly quotes and case", () => {
    const curly = "happy to write up what I’d change, if that’s useful.";
    const body = CLEAN_BODY.replace(APPROVED, curly);
    const claims = [...CLEAN_CLAIMS.slice(0, 3), { span: curly, kind: "offer" as const, evidence_ids: [] }];
    assert.deepEqual(reasons(input({ body, claims })), []);
  });
  test("a proof-point sentence quoted verbatim is an allowed offer", () => {
    const proof = "PulseConf conference platform shipped";
    const body = CLEAN_BODY.replace(APPROVED, `${proof}. ${APPROVED}`);
    const claims = [...CLEAN_CLAIMS, { span: proof, kind: "offer" as const, evidence_ids: [] }];
    assert.deepEqual(reasons(input({ body, claims, proofPoint: `${proof}; 50+ automation workflows.` })), []);
    assert.ok(reasons(input({ body, claims, proofPoint: null })).includes("unapproved_offer"));
  });
});

describe("contradicted evidence — REBG (DoD 5)", () => {
  const rebgEvidence: ClaimEvidence[] = [
    ...EVIDENCE,
    { id: "E4", source: "website", observation: "Broker page explicitly says 'Call or Email anytime' and 'Better yet try the chat icon' — suggesting manual, owner-handled response." },
  ];
  test("detector: a chat-icon quote + hasChatWidget:false → chat contradicted", () => {
    const c = detectContradictions({ evidence: rebgEvidence, techSignals: { hasChatWidget: false }, siteText: `${SITE}\nBetter yet try the chat icon` });
    assert.deepEqual(c.map((x) => x.attribute), ["chat"]);
    assert.ok(c[0]!.absent.includes("tech scan hasChatWidget:false"));
    assert.ok(c[0]!.present.some((p) => p.includes("chat icon")));
  });
  test("a body saying no chat or acknowledgment exists → contradicted_evidence", () => {
    const s = "there's no chat or instant acknowledgment when a buyer reaches out";
    const i = input({ evidence: rebgEvidence, ...withSentence(`Right now ${s}.`, [{ span: s, kind: "inference", evidence_ids: ["E4"] }]) });
    assert.ok(reasons(i).includes("contradicted_evidence"));
  });
  test("even an unclaimed mention of the contested attribute holds", () => {
    const i = input({ evidence: rebgEvidence, ...withSentence("Nothing answers them.") });
    assert.ok(reasons(i).includes("contradicted_evidence"));
  });
  test("no conflict when the scan and the page agree (Gottesman shape)", () => {
    const ev: ClaimEvidence[] = [{ id: "E1", source: "website", observation: "Tech stack shows hasChatWidget: false — no live chat or automated follow-up layer." }];
    assert.deepEqual(detectContradictions({ evidence: ev, techSignals: { hasChatWidget: false }, siteText: "Listings · Contact" }), []);
  });
});

describe("unsupported prospect facts (DoD 7) and the source-page check", () => {
  test('"$1.2M" absent from the cited evidence → unsupported_prospect_fact', () => {
    const s = "your listings start at $1.2M";
    const v = violations(input(withSentence(`I noticed ${s}.`, [{ span: s, kind: "prospect_fact", evidence_ids: ["E2"] }])));
    assert.ok(v.some((x) => x.reason === "unsupported_prospect_fact" && x.token === "$1.2M"));
  });
  test("a fact in the cited evidence but not on the source page → not in source page", () => {
    const ev = [...EVIDENCE, { id: "E4", source: "website", observation: "Team page lists an office in Beaumont." }];
    const s = "you have an office in Beaumont";
    const v = violations(input({ evidence: ev, ...withSentence(`I saw ${s}.`, [{ span: s, kind: "prospect_fact", evidence_ids: ["E4"] }]) }));
    assert.ok(v.some((x) => x.reason === "unsupported_prospect_fact" && x.detail === 'not in source page: "Beaumont"'));
  });
  test("an apollo-only prospect fact skips the page check", () => {
    const s = "you run it as Owner/Broker";
    assert.deepEqual(reasons(input(withSentence(`I see ${s}.`, [{ span: s, kind: "prospect_fact", evidence_ids: ["E3"] }]))), []);
  });
  test("no raw page text → the page check does not run", () => {
    const ev = [...EVIDENCE, { id: "E4", source: "website", observation: "Team page lists an office in Beaumont." }];
    const s = "you have an office in Beaumont";
    assert.deepEqual(reasons(input({ evidence: ev, siteText: null, ...withSentence(`I saw ${s}.`, [{ span: s, kind: "prospect_fact", evidence_ids: ["E4"] }]) })), []);
  });

  describe("Steffen: E3 quotes 'contact us to schedule a preview', the page does not contain it", () => {
    const ev: ClaimEvidence[] = [
      { id: "E1", source: "website", observation: "Auction Gallery page describes consignment intake ('contact us to schedule a preview', flat-rate commission pitch)." },
    ];
    const page = "Auction Gallery\nFlat-rate commission. Consign with us.";
    const base = (body: string, span: string) =>
      input({
        evidence: ev,
        siteText: page,
        subject: "consignment intake",
        body: `${body}\n${APPROVED}`,
        claims: [
          { span, kind: "prospect_fact", evidence_ids: ["E1"] },
          { span: APPROVED, kind: "offer", evidence_ids: [] },
        ],
        allowNames: ["Pat", "Steffen Test Group", "Zyndix"],
      });
    const notOnPage = (i: ClaimCheckInput) =>
      violations(i).some((x) => x.reason === "unsupported_prospect_fact" && x.detail.startsWith("not in source page") && /contact us to schedule a preview/i.test(x.detail));

    test("quoted in the body → unsupported_prospect_fact (not in source page)", () => {
      const span = 'your gallery page asks sellers to "contact us to schedule a preview"';
      assert.ok(notOnPage(base(`I noticed ${span}.`, span)));
    });
    test("reused without quotes → unsupported_prospect_fact (not in source page)", () => {
      const span = "your gallery page asks sellers to contact us to schedule a preview";
      assert.ok(notOnPage(base(`I noticed ${span}.`, span)));
    });
    test("control: the page does contain it → passes", () => {
      const span = 'your gallery page asks sellers to "contact us to schedule a preview"';
      const i = { ...base(`I noticed ${span}.`, span), siteText: `${page}\nContact us to schedule a preview.` };
      assert.deepEqual(violations(i), []);
    });
  });
});

describe("failed crawl (DoD 8) and ledger integrity", () => {
  test("citing a failed-fetch evidence item → failed_crawl_evidence", () => {
    const ev = [...EVIDENCE, { id: "E4", source: "website", observation: "Tech stack fetch failed — no detectable marketing or CRM tooling confirmed." }];
    const s = "nothing routes an inquiry to the right agent";
    assert.ok(reasons(input({ evidence: ev, ...withSentence(`Today ${s}.`, [{ span: s, kind: "inference", evidence_ids: ["E4"] }]) })).includes("failed_crawl_evidence"));
  });
  test("a span not verbatim in the text → span_not_in_body", () => {
    const claims = [...CLEAN_CLAIMS, { span: "you answer every lead within minutes", kind: "inference" as const, evidence_ids: ["E1"] }];
    assert.deepEqual(reasons(input({ claims })), ["span_not_in_body"]);
  });
  test("an evidence id this lead does not have → unknown_evidence_id", () => {
    const claims: Claim[] = [{ ...CLEAN_CLAIMS[0]!, evidence_ids: ["E9"] }, ...CLEAN_CLAIMS.slice(1)];
    // Its facts are then backed by nothing, so they are unsupported too.
    assert.deepEqual(reasons(input({ claims })), ["unknown_evidence_id", "unsupported_prospect_fact"]);
  });
  test("no claim cites evidence → no_cited_evidence", () => {
    const i = input({ subject: "a thought", body: `Hi Enrique,\n\n${APPROVED}`, claims: [CLEAN_CLAIMS[3]!] });
    assert.deepEqual(reasons(i), ["no_cited_evidence"]);
  });
  test("a number the writer invented is uncovered even with claims elsewhere", () => {
    assert.ok(reasons(input(withSentence("Most teams lose 40% of these."))).includes("uncovered_fact"));
  });
  test("a number at the end of a clause stays inside its span (\"since 2004,\" regression)", () => {
    const ev = [...EVIDENCE, { id: "E4", source: "website", observation: "'Serving Houston since 2004' in the header." }];
    const s = "you have served Houston since 2004";
    const i = input({ evidence: ev, siteText: `${SITE}\nServing Houston since 2004`, ...withSentence(`I saw ${s}, and it shows.`, [{ span: s, kind: "prospect_fact", evidence_ids: ["E4"] }]) });
    assert.deepEqual(reasons(i), []);
  });
  test("thousands separators still parse as one number", () => {
    const v = violations(input(withSentence("That is 1,250 inquiries.")));
    assert.ok(v.some((x) => x.reason === "uncovered_fact" && x.token === "1,250"));
  });
  test("a tool name must be covered and supported", () => {
    const v = violations(input(withSentence("A Calendly link would not fix the routing.")));
    assert.ok(v.some((x) => x.reason === "uncovered_fact" && /calendly/i.test(x.token ?? "")));
  });
});

describe("operator edits (DoD 10 shape)", () => {
  test("claims whose span was edited away are dropped; an added place is refused", () => {
    const edited = CLEAN_BODY.replace("so response speed depends on who is free.", "so buyers in Beaumont wait.");
    const kept = claimsStillPresent(CLEAN_CLAIMS, CLEAN_SUBJECT, edited);
    assert.equal(kept.length, 4);
    const v = violations(input({ body: edited, claims: kept }));
    assert.ok(v.some((x) => x.reason === "uncovered_fact" && x.token === "Beaumont"));
  });
  test("deleting a claimed sentence drops its claim and still passes", () => {
    const edited = CLEAN_BODY.replace(" With a second market, every inquiry still lands on the same contact form and phone line, so response speed depends on who is free.", "");
    const kept = claimsStillPresent(CLEAN_CLAIMS, CLEAN_SUBJECT, edited);
    assert.equal(kept.length, 3);
    assert.deepEqual(reasons(input({ body: edited, claims: kept })), []);
  });
  test("editing a claimed fact (20+ → 25+) leaves it uncovered", () => {
    const edited = CLEAN_BODY.replace("20+ years", "25+ years");
    const kept = claimsStillPresent(CLEAN_CLAIMS, CLEAN_SUBJECT, edited);
    const r = reasons(input({ body: edited, claims: kept }));
    assert.ok(r.includes("uncovered_fact"));
  });
});

// 09 §UR: research items appended by qualify carry a verbatim excerpt, a URL
// and their own fetch date.
describe("research evidence (09 §UR)", () => {
  const JOB: ClaimEvidence = {
    id: "E4",
    source: "jobs",
    observation: "Acme Test Realty is looking for a Transaction Coordinator to manage contracts and respond to client emails.",
    source_type: "job_post",
    evidence_item_id: "00000000-0000-4000-8000-0000000000e4",
    url: "https://www.linkedin.com/jobs/view/4400000001",
    title: "Transaction Coordinator",
    published_at: daysAgo(14),
    fetched_at: daysAgo(2),
  };
  const withJob = (sentence: string, span: string, extra: Partial<ClaimCheckInput> = {}, job: ClaimEvidence = JOB) => {
    const evidence = [...EVIDENCE, job];
    return input({
      evidence,
      contradictions: detectContradictions({ evidence, techSignals: { hasChatWidget: false }, siteText: SITE }),
      ...withSentence(sentence, [{ span, kind: "prospect_fact", evidence_ids: ["E4"] }]),
      ...extra,
    });
  };

  test("a claim supported by the research excerpt passes", () => {
    const s = "you are hiring a Transaction Coordinator to respond to client emails";
    assert.deepEqual(violations(withJob(`Right now ${s}.`, s)), []);
  });

  test("a fact not in the excerpt → unsupported_prospect_fact", () => {
    const s = "you are hiring a Marketing Director";
    const v = violations(withJob(`Right now ${s}.`, s));
    assert.ok(v.some((x) => x.reason === "unsupported_prospect_fact" && x.token === "Marketing"));
  });

  test("a paraphrase item cannot carry a fact the research excerpt lacks", () => {
    // E5 is a qualifier paraphrase (website) that mentions the role; the page text does not.
    const evidence = [...EVIDENCE, JOB, { id: "E5", source: "website", observation: "They also post a Marketing Director role." }];
    const s = "you are hiring a Marketing Director";
    const v = violations(
      input({
        evidence,
        contradictions: [],
        ...withSentence(`Right now ${s}.`, [{ span: s, kind: "inference", evidence_ids: ["E4", "E5"] }]),
      }),
    );
    assert.ok(
      v.some((x) => x.reason === "unsupported_prospect_fact" && /cited source excerpt \(E4\): "Marketing"/.test(x.detail)),
      JSON.stringify(v),
    );
  });

  test("a quoted fragment must be in the excerpt", () => {
    const ok = 'your job post asks for someone to "respond to client emails"';
    assert.deepEqual(violations(withJob(`I read that ${ok}.`, ok)), []);
    const bad = 'your job post asks for someone to "answer every call"';
    const v = violations(withJob(`I read that ${bad}.`, bad));
    assert.ok(v.some((x) => x.reason === "unsupported_prospect_fact" && x.token === "answer every call"), JSON.stringify(v));
  });

  test("a stale research item fails stale_evidence even when the site crawl is fresh", () => {
    const s = "you are hiring a Transaction Coordinator to respond to client emails";
    const v = violations(withJob(`Right now ${s}.`, s, { evidenceFetchedAt: daysAgo(1) }, { ...JOB, fetched_at: daysAgo(31) }));
    assert.deepEqual(
      v.map((x) => [x.reason, x.evidence_id]),
      [["stale_evidence", "E4"]],
    );
    assert.match(v[0]!.detail, /^E4 fetched \d{4}-\d{2}-\d{2}, 31 days old \(max 30\)$/);
  });

  test("per-item freshness uses the item's own date, not the lead-level proxy", () => {
    const s = "you are hiring a Transaction Coordinator to respond to client emails";
    // Only E4 is cited in this claim, but CLEAN claims cite E1/E2 (lead-level): a stale crawl still fails for those.
    const v = violations(withJob(`Right now ${s}.`, s, { evidenceFetchedAt: daysAgo(40) }));
    assert.ok(v.some((x) => x.reason === "stale_evidence" && x.evidence_id === undefined));
    assert.ok(!v.some((x) => x.reason === "stale_evidence" && x.evidence_id === "E4"));
    // A step 7 days out: 25 + 7 > 30 for the research item.
    const later = violations(withJob(`Right now ${s}.`, s, { offsetDays: 7, stepNo: 2 }, { ...JOB, fetched_at: daysAgo(25) }));
    assert.ok(later.some((x) => x.reason === "stale_evidence" && /^step 2: E4: 25d \+ 7d > 30d/.test(x.detail)), JSON.stringify(later));
  });

  test("a research excerpt that says 'unavailable' is not a failed crawl", () => {
    const job = { ...JOB, observation: `${JOB.observation} Parking is unavailable on site.` };
    const s = "you are hiring a Transaction Coordinator to respond to client emails";
    assert.ok(!reasons(withJob(`Right now ${s}.`, s, {}, job)).includes("failed_crawl_evidence"));
  });
});
