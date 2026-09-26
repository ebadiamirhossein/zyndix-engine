import type { Claim } from "@/lib/validation/llm";

import {
  angleLabel,
  emailStatusMarker,
  escapeTelegramHtml,
  fitScoreEmoji,
} from "./telegram-format";

type TouchRow = {
  id: string;
  subject: string | null;
  draft_body: string | null;
  body: string | null;
  status: string | null;
};

export type ApprovalTouchRow = TouchRow;

type LeadContext = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email_status: string | null;
};

export type ApprovalLeadContext = LeadContext;

type QualificationContext = {
  fit_score: number | null;
  segment: string | null;
  problem_hypothesis: string;
  /** 09 §UR: a research item carries its own fetch (and publication) date. */
  evidence: { id?: string; observation: string; fetched_at?: string; published_at?: string | null }[];
  recommended_angle: string | null;
  /** The claim ledger the guard accepted (09 §U6b). */
  claims?: Claim[];
  evidence_fetched_at?: string | null;
  evidence_policy_version?: number;
  max_age_days?: number;
};

export type ApprovalQualificationContext = QualificationContext;

type CompanyContext = {
  name: string;
  domain: string | null;
};

export type ApprovalCompanyContext = CompanyContext;

const MAX_CLAIMS_SHOWN = 8;
const EXCERPT_CHARS = 140;

type CardEvidence = QualificationContext["evidence"][number];

/**
 * The date line of one cited item (09 §UR): its own fetch date when it has
 * one, else the lead-level fetch date; plus its publication date if known.
 */
function evidenceDates(item: CardEvidence, leadFetchedAt: string | null | undefined, fetchedLabel: boolean): string {
  const fetched = (item.fetched_at ?? leadFetchedAt)?.slice(0, 10) ?? "unknown";
  const published = item.published_at ? ` · published ${item.published_at.slice(0, 10)}` : "";
  return `${fetchedLabel ? "fetched " : ""}${fetched}${published}`;
}

function excerpt(text: string): string {
  return text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS - 1)}…`;
}

/** Each claim with the evidence it cites: id, fetch date, excerpt (09 §U6b). */
export function formatClaimLines(qualification: QualificationContext): string[] {
  const claims = qualification.claims ?? [];
  const lines: string[] = [];
  for (const claim of claims.slice(0, MAX_CLAIMS_SHOWN)) {
    lines.push(`• [${claim.kind}] “${escapeTelegramHtml(excerpt(claim.span))}”`);
    for (const id of claim.evidence_ids) {
      const item = qualification.evidence.find((e) => e.id === id);
      lines.push(
        item
          ? `   ← ${id} · ${evidenceDates(item, qualification.evidence_fetched_at, true)} · <i>${escapeTelegramHtml(excerpt(item.observation))}</i>`
          : `   ← ${id} · (not found)`,
      );
    }
  }
  if (claims.length > MAX_CLAIMS_SHOWN) lines.push(`• … ${claims.length - MAX_CLAIMS_SHOWN} more claims`);
  return lines;
}

function formatLeadName(lead: LeadContext): string {
  const parts = [lead.first_name, lead.last_name].filter(Boolean);
  return parts.join(" ") || "Unknown";
}

export function formatApprovalMessageHtml(
  touch: TouchRow,
  lead: LeadContext,
  qualification: QualificationContext,
  company: CompanyContext,
): string {
  const name = escapeTelegramHtml(formatLeadName(lead));
  const title = escapeTelegramHtml(lead.title?.trim() || "—");
  const companyName = escapeTelegramHtml(company.name);
  const domain = escapeTelegramHtml(company.domain?.trim() || "—");
  const fit = qualification.fit_score ?? "—";
  const fitIcon = fitScoreEmoji(qualification.fit_score);
  const angle = escapeTelegramHtml(angleLabel(
    qualification.recommended_angle,
    qualification.segment,
  ));
  const emailLine = emailStatusMarker(lead.email_status);

  const claimLines = formatClaimLines(qualification);
  const evidenceBlock =
    claimLines.length > 0
      ? [
          "<b>CLAIMS:</b>",
          ...claimLines,
          `<i>claim guard: pass · evidence_policy v${qualification.evidence_policy_version ?? "?"} (≤${qualification.max_age_days ?? "?"}d)</i>`,
        ]
      : [
          "<b>EVIDENCE:</b>",
          qualification.evidence
            .slice(0, 3)
            .map((item) => `• ${escapeTelegramHtml(item.observation)}`)
            .join("\n") || "• (none)",
        ];

  const subject = escapeTelegramHtml(touch.subject ?? "(none)");
  const body = escapeTelegramHtml(touch.draft_body ?? touch.body ?? "");

  return [
    `🎯 <b>${name}</b> — ${title}`,
    `🏢 ${companyName} · ${domain}`,
    `${fitIcon} fit ${fit}  ·  ${angle}  ·  ${emailLine}`,
    "",
    `<b>WHY:</b> ${escapeTelegramHtml(qualification.problem_hypothesis)}`,
    "",
    ...evidenceBlock,
    "",
    "──────────",
    `<b>SUBJECT:</b> ${subject}`,
    "",
    `<pre>${body}</pre>`,
    "<i>Sender + signature are fixed when you approve; the APPROVED update shows the final text.</i>",
    "──────────",
  ].join("\n");
}

/** Plain-text fallback for terminals / logs. */
export function formatApprovalMessagePlain(
  touch: TouchRow,
  lead: LeadContext,
  qualification: QualificationContext,
  company: CompanyContext,
): string {
  const html = formatApprovalMessageHtml(
    touch,
    lead,
    qualification,
    company,
  );
  return html
    .replace(/<b>(.*?)<\/b>/g, "$1")
    .replace(/<\/?pre>/g, "")
    .replace(/<\/?i>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// ---------------------------------------------------------------------------
// Sequence card (09 §U6c): one card for every step of an email sequence.
// ---------------------------------------------------------------------------

export type SequenceCardStep = {
  touch_id: string;
  step_no: number;
  source: "writer" | "template";
  /** Wait after the previous step (email_sequence semantics). */
  delay: number;
  delay_unit: string;
  /** Days after step 1 this step goes out. */
  offset_days: number;
  /** Step 1's subject; null for follow-ups (rendered "Re: <step-1 subject>"). */
  subject: string | null;
  body: string;
  claims: Claim[];
};

export type SequenceCardInput = {
  steps: SequenceCardStep[];
  sequence_setting_version: number;
};

/** Telegram's limit on one message's text (after entity parsing). */
export const TELEGRAM_TEXT_LIMIT = 4096;

type CardLevel = { excerptChars: number; maxClaims: number; spanChars: number };

// Shrink order when the card is too long: excerpts first, then how many
// claims per step, then span length. Bodies are never truncated.
const CARD_LEVELS: CardLevel[] = [
  { excerptChars: 140, maxClaims: 8, spanChars: 140 },
  { excerptChars: 80, maxClaims: 8, spanChars: 140 },
  { excerptChars: 80, maxClaims: 5, spanChars: 100 },
  { excerptChars: 0, maxClaims: 5, spanChars: 80 },
  { excerptChars: 0, maxClaims: 3, spanChars: 60 },
];

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The text Telegram counts: tags removed, entities decoded. */
export function telegramVisibleLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").length;
}

function unitLabel(n: number, unit: string): string {
  const singular = unit.replace(/s$/, "");
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

function sequenceClaimLines(claims: Claim[], qualification: QualificationContext, level: CardLevel): string[] {
  const lines: string[] = [];
  for (const claim of claims.slice(0, level.maxClaims)) {
    lines.push(`• [${claim.kind}] “${escapeTelegramHtml(cut(claim.span, level.spanChars))}”`);
    for (const id of claim.evidence_ids) {
      const item = qualification.evidence.find((e) => e.id === id);
      if (!item) lines.push(`   ← ${id} · (not found)`);
      else if (level.excerptChars > 0) {
        lines.push(
          `   ← ${id} · ${evidenceDates(item, qualification.evidence_fetched_at, false)} · <i>${escapeTelegramHtml(cut(item.observation, level.excerptChars))}</i>`,
        );
      } else lines.push(`   ← ${id} · ${evidenceDates(item, qualification.evidence_fetched_at, false)}`);
    }
  }
  if (claims.length > level.maxClaims) lines.push(`• … ${claims.length - level.maxClaims} more claims`);
  return lines;
}

function evidenceAgeDays(fetchedAt: string | null | undefined, now: Date): number | null {
  if (!fetchedAt) return null;
  const age = (now.getTime() - Date.parse(fetchedAt)) / 86_400_000;
  return Number.isFinite(age) ? Math.floor(age) : null;
}

function formatSequenceStepBlock(
  step: SequenceCardStep,
  firstSubject: string,
  qualification: QualificationContext,
  level: CardLevel,
  ageDays: number | null,
  now: Date,
): string[] {
  const header =
    step.step_no === 1
      ? "<b>STEP 1 · day 0</b>"
      : `<b>STEP ${step.step_no} · +${unitLabel(step.delay, step.delay_unit)} · same thread</b> (day ${step.offset_days})`;
  const subject = step.step_no === 1 ? firstSubject : `Re: ${firstSubject.replace(/^re:\s*/i, "")}`;
  const cites = step.claims.some((c) => c.evidence_ids.length > 0);
  const max = qualification.max_age_days;
  // 09 §UR: the step's age is its OLDEST cited item (each aged by its own fetch date when it has one).
  const citedAges = [...new Set(step.claims.flatMap((c) => c.evidence_ids))].map((id) => {
    const item = qualification.evidence.find((e) => e.id === id);
    return item?.fetched_at ? evidenceAgeDays(item.fetched_at, now) : ageDays;
  });
  const stepAge = citedAges.length === 0 ? ageDays : citedAges.some((a) => a === null) ? null : Math.max(...(citedAges as number[]));
  const freshness =
    !cites
      ? step.source === "template"
        ? "template · cites no evidence"
        : "cites no evidence"
      : stepAge === null || max === undefined
        ? "freshness: unknown"
        : `freshness: ${stepAge}d + ${step.offset_days}d ≤ ${max}d`;
  const lines = [
    header,
    `<i>${freshness}</i>`,
    `<b>SUBJECT:</b> ${escapeTelegramHtml(subject)}`,
    `<pre>${escapeTelegramHtml(step.body)}</pre>`,
  ];
  if (step.step_no > 1) lines.push("<i>Instantly adds a quote of step 1 below.</i>");
  const claimLines = sequenceClaimLines(step.claims, qualification, level);
  if (claimLines.length > 0) lines.push("<b>CLAIMS:</b>", ...claimLines);
  return lines;
}

/**
 * The sequence card as one or more HTML messages. Normally one: the ladder
 * above shortens the claim evidence until it fits. Only if even the shortest
 * form is too long is it split at step boundaries (buttons go on the last).
 */
export function formatSequenceApprovalMessages(
  sequence: SequenceCardInput,
  lead: LeadContext,
  qualification: QualificationContext,
  company: CompanyContext,
  now: Date = new Date(),
): string[] {
  const steps = [...sequence.steps].sort((a, b) => a.step_no - b.step_no);
  const firstSubject = steps[0]?.subject ?? "(none)";
  const ageDays = evidenceAgeDays(qualification.evidence_fetched_at, now);
  const head = [
    `🎯 <b>${escapeTelegramHtml(formatLeadName(lead))}</b> — ${escapeTelegramHtml(lead.title?.trim() || "—")}`,
    `🏢 ${escapeTelegramHtml(company.name)} · ${escapeTelegramHtml(company.domain?.trim() || "—")}`,
    `${fitScoreEmoji(qualification.fit_score)} fit ${qualification.fit_score ?? "—"}  ·  ${escapeTelegramHtml(
      angleLabel(qualification.recommended_angle, qualification.segment),
    )}  ·  ${emailStatusMarker(lead.email_status)}`,
    "",
    `<b>WHY:</b> ${escapeTelegramHtml(qualification.problem_hypothesis)}`,
    `<i>${steps.length}-step sequence · email_sequence v${sequence.sequence_setting_version} · claim guard: pass · evidence_policy v${
      qualification.evidence_policy_version ?? "?"
    } (≤${qualification.max_age_days ?? "?"}d) · evidence fetched ${qualification.evidence_fetched_at?.slice(0, 10) ?? "unknown"}</i>`,
  ];
  const tail = [
    "──────────",
    "<i>One approval covers every step. Sender + signature are fixed when you approve; the APPROVED update shows the final texts.</i>",
  ];

  let blocks: string[][] = [];
  for (const level of CARD_LEVELS) {
    blocks = steps.map((step) => ["──────────", ...formatSequenceStepBlock(step, firstSubject, qualification, level, ageDays, now)]);
    const whole = [...head, ...blocks.flat(), ...tail].join("\n");
    if (telegramVisibleLength(whole) <= TELEGRAM_TEXT_LIMIT) return [whole];
  }

  // Still too long at the shortest level: split at step boundaries.
  const messages: string[] = [];
  let current = [...head];
  for (const block of blocks) {
    const next = [...current, ...block];
    if (telegramVisibleLength(next.join("\n")) > TELEGRAM_TEXT_LIMIT && current.length > 0) {
      messages.push(current.join("\n"));
      current = [...block];
    } else current = next;
  }
  current.push(...tail);
  messages.push(current.join("\n"));
  return messages;
}
