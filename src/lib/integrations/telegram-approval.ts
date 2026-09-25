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
  evidence: { id?: string; observation: string }[];
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

function excerpt(text: string): string {
  return text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS - 1)}…`;
}

/** Each claim with the evidence it cites: id, fetch date, excerpt (09 §U6b). */
export function formatClaimLines(qualification: QualificationContext): string[] {
  const claims = qualification.claims ?? [];
  const fetched = qualification.evidence_fetched_at?.slice(0, 10) ?? "unknown";
  const lines: string[] = [];
  for (const claim of claims.slice(0, MAX_CLAIMS_SHOWN)) {
    lines.push(`• [${claim.kind}] “${escapeTelegramHtml(excerpt(claim.span))}”`);
    for (const id of claim.evidence_ids) {
      const item = qualification.evidence.find((e) => e.id === id);
      lines.push(
        item
          ? `   ← ${id} · fetched ${fetched} · <i>${escapeTelegramHtml(excerpt(item.observation))}</i>`
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
