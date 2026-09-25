// Claim guard, interim slice (09 §U6b). Pure and deterministic: no model, no
// I/O. The writer returns a claim ledger with its draft; this module decides
// whether every fact in the text is covered by a claim, and whether every claim
// is grounded in this lead's stored evidence. It never trusts the model's kind
// tags: fact tokens inside ANY non-offer claim must be backed by the evidence
// that claim cites.
//
// Both the draft stage and approval (Telegram approve and edit) call
// checkClaims with the same context (claims-context.ts), so a draft is judged
// the same way when written and when approved.
//
// Superseded by U15 (typed evidence ids, per-item dates, verbatim excerpts) and
// U17 (the guard over approved knowledge facts). Known interim gaps are listed
// in 06: lowercase place names, spelled-out numbers below three.

import type { Claim } from "@/lib/validation/llm";
import { describesFailedFetch } from "@/lib/validation/llm";

import { numberAllowedInSources } from "./guard";

export type ClaimReason =
  | "span_not_in_body"
  | "unknown_evidence_id"
  | "uncovered_fact"
  | "unsupported_prospect_fact"
  | "invented_timing"
  | "unbacked_asset_claim"
  | "unapproved_offer"
  | "stale_evidence"
  | "contradicted_evidence"
  | "failed_crawl_evidence"
  | "no_cited_evidence";

export type ClaimViolation = {
  reason: ClaimReason;
  detail: string;
  token?: string;
  span?: string;
  evidence_id?: string;
};

export type ClaimEvidence = { id: string; source: string | null; observation: string };

export type ContradictionAttribute = "chat" | "booking" | "contact_form";

export type Contradiction = {
  attribute: ContradictionAttribute;
  absent: string[];
  present: string[];
};

export type ClaimCheckInput = {
  subject: string;
  /** Body content only — the compliance footer already stripped (splitComplianceFooter). */
  body: string;
  claims: Claim[];
  evidence: ClaimEvidence[];
  /** Raw crawled page text (newest non-error apify_site), or null when none exists. */
  siteText: string | null;
  /** Interim evidence age: the lead's latest non-error enrichment fetch. */
  evidenceFetchedAt: string | null;
  now: Date;
  maxAgeDays: number;
  approvedOfferLines: string[];
  proofPoint: string | null;
  /** Firmographics the text may name freely: lead name, company name, domain, "Zyndix". */
  allowNames: string[];
  visibleTools: string[];
  contradictions: Contradiction[];
  /** Extra texts whose lowercase words mark a sentence-initial capital as a common word (hypothesis). */
  contextTexts?: string[];
};

export type ClaimCheckResult = { ok: true } | { ok: false; violations: ClaimViolation[] };

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** 1:1 character canonicalisation, so positions in the result match the input. */
function canon1(text: string): string {
  return text
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s/g, " ")
    .toLowerCase();
}

/** Loose canonical form for equality/containment (not position-preserving). */
export function looseCanon(text: string): string {
  return text
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/["']/g, (q, offset: number, whole: string) => {
      // keep apostrophes inside words ("that's"), drop quote marks
      const before = whole[offset - 1] ?? " ";
      const after = whole[offset + 1] ?? " ";
      return q === "'" && /\w/.test(before) && /\w/.test(after) ? q : "";
    })
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripTrailingPunct(text: string): string {
  return text.replace(/[\s.!?,;:]+$/, "");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWord(haystackLower: string, needle: string): boolean {
  const n = needle.toLowerCase().replace(/['’]s$/, "");
  if (!n) return true;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(n)}(?![\\p{L}\\p{N}])`, "u").test(haystackLower);
}

/** Splits the compliance footer (appended after the guard at draft time) off the body. */
export function splitComplianceFooter(body: string, footer: string | null): { content: string; hadFooter: boolean } {
  const trimmedBody = body.replace(/\s+$/, "");
  const f = (footer ?? "").trim();
  if (f && trimmedBody.endsWith(f)) {
    return { content: trimmedBody.slice(0, trimmedBody.length - f.length).replace(/\s+$/, ""), hadFooter: true };
  }
  return { content: trimmedBody, hadFooter: false };
}

// ---------------------------------------------------------------------------
// Fact tokens
// ---------------------------------------------------------------------------

type Field = "subject" | "body";
type TokenKind = "number" | "name" | "tool" | "timing";
type Token = { field: Field; start: number; end: number; text: string; kind: TokenKind; value: string };

// Comma groups only as real thousands separators, so "since 2004," ends at 4.
const NUMBER_RE = /\$?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(?:%|\+|[MmKkBb]\b))?/g;
const NUMBER_WORD_RE =
  /\b(three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|dozens?|hundreds?|thousands?|millions?|billions?)\b/gi;

const TIMING_RES: RegExp[] = [
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b/gi,
  /\bweekends?\b/gi,
  /\b(?:tonight|overnight|midnight|midday|noon)\b/gi,
  /\b(?:mornings?|afternoons?|evenings?|nights?)\b/gi,
  /\bafter[- ]hours\b/gi,
  /\b(?:business|office|working) hours\b/gi,
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)(?![\p{L}])/giu,
  /\b\d{1,2}\s*o'clock\b/gi,
  /\buntil (?:tomorrow|the next day|next week)\b/gi,
];

const KNOWN_TOOLS = [
  "calendly",
  "hubspot",
  "zillow",
  "realtor.com",
  "kvcore",
  "follow up boss",
  "boomtown",
  "lofty",
  "chime",
  "sierra interactive",
  "salesforce",
  "intercom",
  "drift",
  "zapier",
  "mailchimp",
  "luxury presence",
  "wordpress",
  "wix",
  "squarespace",
  "idx broker",
  "showingtime",
  "acuity",
  "gohighlevel",
  "highlevel",
  "podium",
  "birdeye",
  "zendesk",
  "tidio",
  "livechat",
  "facebook",
  "instagram",
  "linkedin",
  "google",
];

const GENERIC_ACRONYMS = new Set(["crm", "mls", "idx", "ai", "sms", "faq", "pdf", "seo", "ok", "okay"]);
const I_FORMS = new Set(["i", "i'm", "i've", "i'd", "i'll"]);

const COMMON_STARTERS = new Set(
  (
    "the a an and but or so if when while since because as at in on of for to from with by about after before during " +
    "your you you're you've yours we we're we've our us i it it's its this that these those there there's they they're " +
    "their them he she his her what which who whom whose why how where most many much more some any all every each no " +
    "not none nothing nobody one two just only also still even quick curious noticed saw seeing looked looks looking read " +
    "reading came coming spotted happy worth would could should might may can will do does did is are was were be been " +
    "being have has had here hi hey hello thanks thank right now then yet though although however usually often sometimes " +
    "buyers sellers clients people teams brokers agents owners leads inquiries prospects someone anyone everyone either " +
    "neither both same other another such than out up down over under off new first last next few several means " +
    "meaning today yes sure great good"
  ).split(" "),
);

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu;

function isSentenceInitial(text: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && ` \t"'“‘(*`.includes(text[i]!)) i--;
  if (i < 0) return true;
  return ".!?:\n\r".includes(text[i]!);
}

function lowercaseWords(texts: string[]): Set<string> {
  const words = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(WORD_RE)) {
      const w = m[0].replace(/[.'’-]+$/, "");
      if (w && w === w.toLowerCase()) words.add(w);
    }
  }
  return words;
}

function allowNameWords(allowNames: string[]): Set<string> {
  const set = new Set<string>();
  for (const name of allowNames) {
    const lower = name.toLowerCase().trim();
    if (!lower) continue;
    set.add(lower);
    for (const part of lower.split(/[^\p{L}\p{N}]+/u)) {
      if (part.length >= 2) set.add(part);
    }
  }
  return set;
}

function extractTokens(field: Field, text: string, input: ClaimCheckInput, lowerCorpus: Set<string>, allow: Set<string>): Token[] {
  const tokens: Token[] = [];

  for (const m of text.matchAll(NUMBER_RE)) {
    tokens.push({ field, start: m.index!, end: m.index! + m[0].length, text: m[0].trim(), kind: "number", value: m[1]!.replace(/,/g, "") });
  }
  for (const m of text.matchAll(NUMBER_WORD_RE)) {
    tokens.push({ field, start: m.index!, end: m.index! + m[0].length, text: m[0], kind: "number", value: m[0].toLowerCase() });
  }
  for (const re of TIMING_RES) {
    for (const m of text.matchAll(re)) {
      tokens.push({ field, start: m.index!, end: m.index! + m[0].length, text: m[0], kind: "timing", value: m[0].toLowerCase() });
    }
  }

  const lower = text.toLowerCase();
  const tools = [...KNOWN_TOOLS, ...input.visibleTools.map((t) => t.trim().toLowerCase())].filter(
    (t) => t.length > 2 && t !== "none_detected",
  );
  for (const tool of new Set(tools)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(tool)}(?![\\p{L}\\p{N}])`, "gu");
    for (const m of lower.matchAll(re)) {
      tokens.push({ field, start: m.index!, end: m.index! + m[0].length, text: text.slice(m.index!, m.index! + m[0].length), kind: "tool", value: tool });
    }
  }

  for (const m of text.matchAll(WORD_RE)) {
    const raw = m[0].replace(/[.'’-]+$/, "");
    if (!/\p{Lu}/u.test(raw)) continue;
    if (/^\d/.test(raw)) continue;
    const word = raw.replace(/['’]s$/, "");
    const wl = word.toLowerCase().replace(/’/g, "'");
    if (I_FORMS.has(wl) || GENERIC_ACRONYMS.has(wl) || allow.has(wl)) continue;
    const start = m.index!;
    const mixedCase = /\p{Ll}/u.test(word.slice(1)) && /\p{Lu}/u.test(word.slice(1));
    if (!mixedCase && isSentenceInitial(text, start) && word === word[0] + word.slice(1).toLowerCase()) {
      if (COMMON_STARTERS.has(wl) || lowerCorpus.has(wl)) continue;
    }
    tokens.push({ field, start, end: start + word.length, text: word, kind: "name", value: wl });
  }

  // "9pm" is one timing token, not also the number 9.
  const timing = tokens.filter((t) => t.kind === "timing");
  return tokens.filter(
    (t) => t.kind !== "number" || !timing.some((tt) => t.start >= tt.start && t.end <= tt.end),
  );
}

// ---------------------------------------------------------------------------
// Claims: locations and evidence
// ---------------------------------------------------------------------------

type Range = { field: Field; start: number; end: number };

function locate(span: string, fields: Record<Field, string>): Range[] {
  const needle = canon1(span);
  const ranges: Range[] = [];
  if (!needle.trim()) return ranges;
  for (const field of ["subject", "body"] as const) {
    const hay = canon1(fields[field]);
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      ranges.push({ field, start: at, end: at + needle.length });
      from = at + 1;
    }
  }
  return ranges;
}

function within(token: Token, ranges: Range[]): boolean {
  return ranges.some((r) => r.field === token.field && token.start >= r.start && token.end <= r.end);
}

function evidenceIndex(id: string, evidence: ClaimEvidence[]): ClaimEvidence | null {
  return evidence.find((item) => item.id === id) ?? null;
}

const QUOTE_RE = /(?:^|[\s(—–-])["'“‘]([^"“”\n]+?)["'”’](?=[\s.,;:!?)—–-]|$)/g;

/** Quoted fragments of at least `minWords` words. */
export function quotedFragments(text: string, minWords = 2): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(QUOTE_RE)) {
    const frag = m[1]!.trim();
    if (frag.split(/\s+/).length >= minWords) out.push(frag);
  }
  return out;
}

function tokenSupported(token: Token, supportTexts: string[], supportLower: string): boolean {
  if (token.kind === "number" && /^\d/.test(token.value)) {
    return numberAllowedInSources(token.value, supportTexts);
  }
  return containsWord(supportLower, token.kind === "tool" ? token.value : token.text);
}

// ---------------------------------------------------------------------------
// Rule patterns
// ---------------------------------------------------------------------------

const ASSET_RE =
  /\b(?:i|we)(?:'ve|’ve| have)?\s+(?:already\s+|just\s+)?(?:mapped out|mapped|prepared|put together|pulled together|drafted|built|created|written up|wrote up|sketched out|sketched|attached)\b/gi;

const OFFER_RES: RegExp[] = [
  /\b(?:i|we)(?:'d|’d| would| can| could|'ll|’ll| will)\s+(?:love to\s+|be happy to\s+|happily\s+|gladly\s+)?(?:help|build|set up|fix|map|send|share|write|show|walk|put|draft|audit|review|change|do|jump|hop)\b/gi,
  /\bhappy to\b/gi,
  /\bwant me to\b/gi,
  /\bfree (?:audit|call|consult\w*|review|assessment|teardown)\b/gi,
  /\bworth a (?:quick |short |brief )?(?:call|chat|conversation)\b/gi,
  /\bopen to (?:a )?(?:quick |short )?(?:call|chat)\b/gi,
  /\bhop on a (?:quick |short )?call\b/gi,
];

const MENTION_RES: Record<ContradictionAttribute, RegExp> = {
  chat:
    /\bchat(?:bot|s)?\b|\backnowledg\w*|\binstant (?:reply|replies|response|responses)\b|\bauto-?(?:reply|replies|responder)\b|\b(?:nothing|nobody|no one) (?:answers|responds|replies)\b/i,
  booking: /\bbook(?:ing|ed)?\b|\bschedul\w*|\bcalendar\b/i,
  contact_form: /\bforms?\b/i,
};

// ---------------------------------------------------------------------------
// Contradictions (interim rule, 09 §U6b)
// ---------------------------------------------------------------------------

const PRESENT_RES: Record<ContradictionAttribute, RegExp> = {
  chat: /\bchat (?:icon|widget|button|bubble|box|now|with us)\b|\blive chat\b/i,
  booking:
    /\b(?:book|schedule) (?:a|an|your) (?:call|showing|tour|consultation|appointment|meeting|viewing|preview)\b|calendly\.com|\bbook now\b/i,
  contact_form:
    /\b(?:contact|inquiry|enquiry|intake|lead) form\b|\bsend (?:us )?(?:a )?message\b|\bsubmit (?:your )?(?:inquiry|request|message)\b/i,
};

const NEGATED_RES: Record<ContradictionAttribute, RegExp> = {
  chat: /\b(?:no|without|lacks?|missing)\b[^.;]{0,50}\bchat\b/i,
  booking: /\b(?:no|without|lacks?|missing)\b[^.;]{0,60}\b(?:booking|scheduling|scheduler|calendar)\b/i,
  contact_form: /\b(?:no|without|lacks?|missing)\b[^.;]{0,40}\bform\b/i,
};

export type TechSignals = Record<string, unknown> | null;

/**
 * Two sources disagree on one attribute: something says it is missing (the
 * tech scan, or an evidence item stating its absence) and something shows it
 * (a quoted page fragment in the evidence, the raw page text, or an evidence
 * item stating it plainly). The REBG case: "Better yet try the chat icon" on
 * the page while the scan says hasChatWidget:false.
 */
export function detectContradictions(input: {
  evidence: ClaimEvidence[];
  techSignals: TechSignals;
  siteText: string | null;
}): Contradiction[] {
  const out: Contradiction[] = [];
  for (const attribute of ["chat", "booking", "contact_form"] as const) {
    const absent: string[] = [];
    const present: string[] = [];
    if (attribute === "chat" && input.techSignals?.hasChatWidget === false) absent.push("tech scan hasChatWidget:false");
    for (const item of input.evidence) {
      const negated = NEGATED_RES[attribute].test(item.observation);
      if (negated) absent.push(`${item.id} states it is missing`);
      const quoted = quotedFragments(item.observation, 1).find((frag) => PRESENT_RES[attribute].test(frag));
      if (quoted) present.push(`${item.id} quotes "${quoted}"`);
      else if (!negated && PRESENT_RES[attribute].test(item.observation)) present.push(`${item.id} states it is present`);
    }
    const siteMatch = input.siteText?.match(PRESENT_RES[attribute]);
    if (siteMatch) present.push(`page text has "${siteMatch[0]}"`);
    if (absent.length > 0 && present.length > 0) out.push({ attribute, absent, present });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export function checkClaims(input: ClaimCheckInput): ClaimCheckResult {
  const violations: ClaimViolation[] = [];
  const seen = new Set<string>();
  const add = (v: ClaimViolation) => {
    const key = `${v.reason}|${v.token ?? ""}|${v.span ?? ""}|${v.evidence_id ?? ""}|${v.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(v);
  };

  const fields: Record<Field, string> = { subject: input.subject, body: input.body };
  const allow = allowNameWords(input.allowNames);
  const allowTexts = input.allowNames.filter(Boolean);
  const lowerCorpus = lowercaseWords([
    input.subject,
    input.body,
    ...input.evidence.map((e) => e.observation),
    ...(input.contextTexts ?? []),
  ]);
  const tokens = [
    ...extractTokens("subject", input.subject, input, lowerCorpus, allow),
    ...extractTokens("body", input.body, input, lowerCorpus, allow),
  ];
  const siteLower = input.siteText ? looseCanon(input.siteText) : null;

  // Locate every claim; an unlocatable span covers nothing.
  const located = input.claims.map((claim) => ({ claim, ranges: locate(claim.span, fields) }));
  for (const { claim, ranges } of located) {
    if (ranges.length === 0) {
      add({ reason: "span_not_in_body", detail: "claim span is not verbatim in the subject or body", span: claim.span });
    }
  }

  // Evidence ids, failed crawls.
  let citesEvidence = false;
  let groundedClaim = false;
  for (const { claim } of located) {
    for (const id of claim.evidence_ids) {
      const item = evidenceIndex(id, input.evidence);
      if (!item) {
        add({ reason: "unknown_evidence_id", detail: `${id} does not exist for this lead (E1–E${input.evidence.length})`, span: claim.span, evidence_id: id });
        continue;
      }
      citesEvidence = true;
      if ((claim.kind === "prospect_fact" || claim.kind === "inference")) groundedClaim = true;
      if (describesFailedFetch(item.observation)) {
        add({ reason: "failed_crawl_evidence", detail: `${id} describes a failed or missing fetch`, span: claim.span, evidence_id: id });
      }
    }
  }
  if (!groundedClaim) {
    add({ reason: "no_cited_evidence", detail: "no prospect_fact or inference claim cites this lead's evidence" });
  }

  // Freshness (interim: one fetch date per lead).
  if (citesEvidence) {
    if (!input.evidenceFetchedAt) {
      add({ reason: "stale_evidence", detail: "evidence fetch date is unknown" });
    } else {
      const fetched = new Date(input.evidenceFetchedAt);
      const ageDays = (input.now.getTime() - fetched.getTime()) / 86_400_000;
      if (!Number.isFinite(ageDays) || ageDays > input.maxAgeDays) {
        add({
          reason: "stale_evidence",
          detail: `evidence fetched ${input.evidenceFetchedAt.slice(0, 10)}, ${Math.floor(ageDays)} days old (max ${input.maxAgeDays})`,
        });
      }
    }
  }

  const allRanges = located.flatMap((l) => l.ranges);
  const offerRanges = located.filter((l) => l.claim.kind === "offer").flatMap((l) => l.ranges);

  // Timing: never supportable from a public crawl, unless a prospect_fact cites
  // evidence that states the same token (e.g. published office hours).
  for (const token of tokens.filter((t) => t.kind === "timing")) {
    const backed = located.some(
      (l) =>
        l.claim.kind === "prospect_fact" &&
        within(token, l.ranges) &&
        l.claim.evidence_ids.some((id) => {
          const item = evidenceIndex(id, input.evidence);
          return item ? containsWord(item.observation.toLowerCase(), token.value) : false;
        }),
    );
    if (!backed) {
      add({ reason: "invented_timing", detail: "weekday or time-of-day assertion with no evidence behind it", token: token.text });
    }
  }

  // Coverage: every other fact token sits inside some claim span.
  for (const token of tokens.filter((t) => t.kind !== "timing")) {
    if (!within(token, allRanges)) {
      add({ reason: "uncovered_fact", detail: `${token.kind} "${token.text}" is not inside any claim`, token: token.text });
    }
  }

  // Support: fact tokens inside non-offer claims must be in the cited evidence
  // (or the firmographics); prospect facts must also be on the source page.
  for (const { claim, ranges } of located) {
    if (claim.kind === "offer" || ranges.length === 0) continue;
    const cited = claim.evidence_ids.map((id) => evidenceIndex(id, input.evidence)).filter((e): e is ClaimEvidence => e !== null);
    const supportTexts = [...cited.map((e) => e.observation), ...allowTexts];
    const supportLower = supportTexts.join("\n").toLowerCase();
    const inClaim = tokens.filter((t) => t.kind !== "timing" && within(t, ranges));
    const ids = claim.evidence_ids.join(",") || "none";

    for (const token of inClaim) {
      if (!tokenSupported(token, supportTexts, supportLower)) {
        add({
          reason: "unsupported_prospect_fact",
          detail: `${claim.kind}: "${token.text}" is not in the cited evidence (${ids})`,
          token: token.text,
          span: claim.span,
        });
      }
    }

    const pageCheck = claim.kind === "prospect_fact" && siteLower !== null && cited.some((e) => e.source === "website");
    if (!pageCheck) continue;
    for (const token of inClaim) {
      if (token.kind === "name" && allow.has(token.value)) continue;
      if (allowTexts.some((name) => containsWord(name.toLowerCase(), token.kind === "tool" ? token.value : token.text))) continue;
      if (!tokenSupported(token, [input.siteText!], siteLower!)) {
        add({ reason: "unsupported_prospect_fact", detail: `not in source page: "${token.text}"`, token: token.text, span: claim.span });
      }
    }
    const spanLoose = looseCanon(claim.span);
    const fragments = [
      ...quotedFragments(claim.span, 2),
      ...cited.flatMap((e) => quotedFragments(e.observation, 3)).filter((frag) => spanLoose.includes(looseCanon(frag))),
    ];
    for (const frag of new Set(fragments)) {
      if (!siteLower!.includes(looseCanon(frag))) {
        add({ reason: "unsupported_prospect_fact", detail: `not in source page: "${frag}"`, token: frag, span: claim.span });
      }
    }
  }

  // Assets: none exist until the knowledge library (U10–U13).
  for (const field of ["subject", "body"] as const) {
    for (const m of fields[field].matchAll(ASSET_RE)) {
      add({ reason: "unbacked_asset_claim", detail: "claims a prepared asset; no stored asset exists", token: m[0] });
    }
  }

  // Offers: only the approved lines (or the segment proof point, verbatim).
  const approved = input.approvedOfferLines.map((line) => stripTrailingPunct(looseCanon(line)));
  const proof = input.proofPoint ? looseCanon(input.proofPoint) : null;
  for (const { claim } of located) {
    if (claim.kind !== "offer") continue;
    const span = stripTrailingPunct(looseCanon(claim.span));
    const ok = approved.includes(span) || (proof !== null && span.length > 0 && proof.includes(span));
    if (!ok) add({ reason: "unapproved_offer", detail: "offer text is not an approved CTA line", span: claim.span });
  }
  for (const field of ["subject", "body"] as const) {
    const hay = canon1(fields[field]);
    for (const re of OFFER_RES) {
      for (const m of hay.matchAll(re)) {
        const token: Token = { field, start: m.index!, end: m.index! + m[0].length, text: m[0], kind: "name", value: m[0] };
        if (!within(token, offerRanges)) {
          add({ reason: "unapproved_offer", detail: "offer language outside the approved CTA line", token: fields[field].slice(token.start, token.end) });
        }
      }
    }
  }

  // Contradicted attributes: any mention holds the draft.
  for (const c of input.contradictions) {
    const text = `${input.subject}\n${input.body}`;
    const m = text.match(MENTION_RES[c.attribute]);
    if (m) {
      add({
        reason: "contradicted_evidence",
        detail: `${c.attribute}: evidence conflicts (${c.absent.join("; ")} vs ${c.present.join("; ")})`,
        token: m[0],
      });
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** One line per violation, for retry hints, lead events and Telegram refusals. */
export function formatViolations(violations: ClaimViolation[], max = 12): string[] {
  const lines = violations.slice(0, max).map((v) => {
    const what = v.token ? ` "${v.token}"` : v.span ? ` "${v.span.slice(0, 80)}"` : "";
    return `${v.reason}${what}: ${v.detail}`;
  });
  if (violations.length > max) lines.push(`… and ${violations.length - max} more`);
  return lines;
}

/**
 * For an operator edit: keep only the claims whose span is still in the text.
 * Dropping a claim can only remove coverage, so anything the edit added (or
 * any fact whose claim was edited away) fails as uncovered.
 */
export function claimsStillPresent(claims: Claim[], subject: string, body: string): Claim[] {
  return claims.filter((claim) => locate(claim.span, { subject, body }).length > 0);
}
