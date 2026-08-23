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
  evidence: { observation: string }[];
  recommended_angle: string | null;
};

export type ApprovalQualificationContext = QualificationContext;

type CompanyContext = {
  name: string;
  domain: string | null;
};

export type ApprovalCompanyContext = CompanyContext;

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

  const evidenceLines = qualification.evidence
    .slice(0, 3)
    .map((item) => `• ${escapeTelegramHtml(item.observation)}`)
    .join("\n");

  const subject = escapeTelegramHtml(touch.subject ?? "(none)");
  const body = escapeTelegramHtml(touch.draft_body ?? touch.body ?? "");

  return [
    `🎯 <b>${name}</b> — ${title}`,
    `🏢 ${companyName} · ${domain}`,
    `${fitIcon} fit ${fit}  ·  ${angle}  ·  ${emailLine}`,
    "",
    `<b>WHY:</b> ${escapeTelegramHtml(qualification.problem_hypothesis)}`,
    "",
    "<b>EVIDENCE:</b>",
    evidenceLines || "• (none)",
    "",
    "──────────",
    `<b>SUBJECT:</b> ${subject}`,
    "",
    `<pre>${body}</pre>`,
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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
