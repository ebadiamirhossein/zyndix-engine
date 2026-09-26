import {
  parseOrThrow,
  qualifierOutputSchema,
  replyClassifierOutputSchema,
  writerOutputSchema,
} from "../src/lib/validation";
import { canTransition, type LeadState } from "../src/types/enums";

type TestResult = { name: string; pass: boolean; detail?: string };

const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

const validQualifier = {
  fit_score: 82,
  segment: "us-realestate",
  problem_hypothesis:
    "Their listings page routes to a bare contact form with no booking link.",
  evidence: [
    {
      source: "website",
      observation: "Contact page is a form only — no Calendly or booking tool.",
    },
  ],
  triggers: ["hiring_admin"],
  visible_tools: ["none_detected"],
  recommended_angle: "speed-to-lead",
  disqualify_reason: null,
};

assert(
  "valid qualifier output parses",
  qualifierOutputSchema.safeParse(validQualifier).success,
);

assert(
  "qualifier with hypothesis but empty evidence FAILS",
  !qualifierOutputSchema.safeParse({ ...validQualifier, evidence: [] }).success,
);

assert(
  'visible_tools with "none_detected" plus other tools FAILS',
  !qualifierOutputSchema.safeParse({
    ...validQualifier,
    visible_tools: ["gtm", "none_detected"],
  }).success,
);

assert(
  "qualifier with disqualify_reason and no hypothesis PASSES",
  qualifierOutputSchema.safeParse({
    fit_score: 20,
    segment: "other",
    problem_hypothesis: null,
    evidence: [],
    triggers: [],
    visible_tools: ["none_detected"],
    recommended_angle: "speed-to-lead",
    disqualify_reason: "Enterprise — 250+ employees",
  }).success,
);

assert(
  "qualifier evidence citing UNAVAILABLE/failed fetch FAILS",
  !qualifierOutputSchema.safeParse({
    ...validQualifier,
    evidence: [
      {
        source: "website",
        observation:
          "UNAVAILABLE — we failed to fetch tech stack; therefore no CRM tools detected.",
      },
    ],
  }).success,
);

assert(
  "qualifier with unexpected key FAILS (strict)",
  !qualifierOutputSchema.safeParse({ ...validQualifier, extra_field: true })
    .success,
);

const words130 = Array.from({ length: 130 }, (_, i) => `word${i}`).join(" ");
const words90 = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");

assert(
  "writer 130-word body FAILS",
  !writerOutputSchema.safeParse({ subject: "quick note", body: words130 }).success,
);

assert(
  "writer 90-word body passes",
  // U6b (Session 15): the writer output carries a claim ledger (min 1).
  writerOutputSchema.safeParse({
    subject: "quick note",
    body: words90,
    claims: [{ span: "word0 word1", kind: "prospect_fact", evidence_ids: ["E1"] }],
  }).success,
);

assert(
  "canTransition('sourced','contacted') is false",
  canTransition("sourced", "contacted" as LeadState) === false,
);

assert(
  "canTransition('sourced','enriching') is true",
  canTransition("sourced", "enriching") === true,
);

let parseOrThrowHasContext = false;
try {
  parseOrThrow(qualifierOutputSchema, { bad: true }, "test-context");
} catch (error) {
  parseOrThrowHasContext =
    error instanceof Error && error.message.includes("[validation:test-context]");
}

assert(
  "parseOrThrow throws with context string",
  parseOrThrowHasContext,
);

const validClassifier = {
  classification: "interested",
  sentiment: "positive",
  suggested_action: "book_link",
  suggested_reply: "Happy to share the audit link whenever works for you.",
  route_to_human: true,
  confidence: 0.92,
  reason: "Prospect asked to schedule a call.",
};

assert(
  "valid classifier output parses",
  replyClassifierOutputSchema.safeParse(validClassifier).success,
);

assert(
  "classifier confidence 0.5 with route_to_human false FAILS",
  !replyClassifierOutputSchema.safeParse({
    ...validClassifier,
    confidence: 0.5,
    route_to_human: false,
  }).success,
);

assert(
  "classifier confidence 0.5 with route_to_human true PASSES",
  replyClassifierOutputSchema.safeParse({
    ...validClassifier,
    confidence: 0.5,
    route_to_human: true,
  }).success,
);

assert(
  "classifier missing route_to_human FAILS",
  !replyClassifierOutputSchema.safeParse({
    classification: "question",
    sentiment: "neutral",
    suggested_action: "answer_question",
    suggested_reply: "Here is a short answer.",
    confidence: 0.9,
    reason: "Direct pricing question.",
  }).success,
);

assert(
  "unsubscribe with suggested_reply null PASSES",
  replyClassifierOutputSchema.safeParse({
    classification: "unsubscribe",
    sentiment: "negative",
    suggested_action: "stop_and_suppress",
    suggested_reply: null,
    route_to_human: false,
    confidence: 0.95,
    reason: "Explicit opt-out language in reply.",
  }).success,
);

const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length} test(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${results.length} checks passed.`);
