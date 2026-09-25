const BANNED_PHRASES = [
  "ai automation",
  "automation solutions",
  "streamline your business",
  "leverage ai",
  "in today's fast-paced",
  "i hope this email finds you",
  "revolutionize",
] as const;

const CLIENT_CLAIM_PATTERNS = [
  "we work with",
  "a client of ours",
  "we helped",
  "one of our clients",
  "a broker we",
  "we wired",
  "after we",
] as const;

const STAT_PHRASE_PATTERNS = [
  "studies show",
  "studies consistently show",
  "research shows",
  "research finds",
  "data shows",
  "on average",
  "industry average",
  "statistics",
  "% of",
  "typically ",
] as const;

const OUT_OF_PATTERN = /\d+\s+out\s+of\s+\d+/i;

const STOPWORDS = new Set([
  "the",
  "their",
  "they",
  "with",
  "from",
  "that",
  "this",
  "have",
  "has",
  "been",
  "were",
  "when",
  "where",
  "which",
  "while",
  "would",
  "could",
  "should",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "again",
  "further",
  "then",
  "once",
  "only",
  "also",
  "just",
  "your",
  "page",
  "site",
  "form",
  "contact",
  "email",
  "phone",
  "call",
  "listing",
  "listings",
  "agent",
  "agents",
  "team",
  "lead",
  "leads",
]);

export type GenericGuardInput = {
  body: string;
  problemHypothesis: string;
  companyName: string;
  companyDomain: string | null;
  visibleTools: string[];
  evidence: { observation: string }[];
  proofPoint: string | null;
  /** Texts from which numerals are allowed (evidence, hypothesis, CTA, proof, firmographics). */
  numberSourceTexts: string[];
};

export type GenericGuardResult =
  | { ok: true; matched: string }
  | { ok: false; reason: string; offendingNumbers?: string[] };

function normalizeNumeral(raw: string): string {
  return raw.replace(/,/g, "").trim();
}

/** Extract numeric tokens from text (digits, decimals, $3M-style, 9+, percentages). */
export function extractNumeralsFromText(text: string): string[] {
  const found = new Set<string>();

  const patterns = [
    /\$(\d[\d,]*(?:\.\d+)?)\s*[MmKkBb]?\b/g,
    /(\d[\d,]*(?:\.\d+)?)\s*%/g,
    /(\d[\d,]*(?:\.\d+)?)\+(?!\d)/g,
    /\b(\d[\d,]*(?:\.\d+)?)\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const token = normalizeNumeral(match[1]!);
      if (token.length > 0) {
        found.add(token);
      }
    }
  }

  return [...found];
}

export function numberAllowedInSources(num: string, sourceTexts: string[]): boolean {
  const normalized = normalizeNumeral(num);
  const allowed = new Set<string>();
  for (const text of sourceTexts) {
    for (const token of extractNumeralsFromText(text)) {
      allowed.add(token);
    }
  }

  if (allowed.has(normalized)) {
    return true;
  }

  // Allow substring match in source (e.g. "9" from evidence "9+ auctions")
  for (const text of sourceTexts) {
    const compact = text.replace(/,/g, "");
    const boundary = new RegExp(
      `(?<![\\d.])${normalized.replace(".", "\\.")}(?:\\+|%|\\s*[MmKkBb]|(?![\\d.]))`,
      "i",
    );
    if (boundary.test(compact)) {
      return true;
    }
  }

  return false;
}

export function checkInventedNumbers(
  body: string,
  sourceTexts: string[],
): GenericGuardResult | { ok: true } {
  const bodyLower = body.toLowerCase();

  for (const phrase of STAT_PHRASE_PATTERNS) {
    if (bodyLower.includes(phrase)) {
      return { ok: false, reason: `invented statistic phrase: "${phrase}"` };
    }
  }

  if (OUT_OF_PATTERN.test(body)) {
    return { ok: false, reason: 'invented statistic phrase: "X out of Y"' };
  }

  const bodyNumerals = extractNumeralsFromText(body);
  const offending: string[] = [];

  for (const num of bodyNumerals) {
    if (!numberAllowedInSources(num, sourceTexts)) {
      offending.push(num);
    }
  }

  if (offending.length > 0) {
    console.warn(
      `[draft] invented number(s) rejected: ${offending.join(", ")}`,
    );
    return {
      ok: false,
      reason: `invented number(s) not in evidence/firmographics: ${offending.join(", ")}`,
      offendingNumbers: offending,
    };
  }

  return { ok: true };
}

function extractEvidenceTerms(evidence: { observation: string }[]): string[] {
  const terms = new Set<string>();

  for (const item of evidence) {
    for (const match of item.observation.matchAll(
      /\b[A-Z][a-z]+(?:[''][a-z]+)?(?:\s+[A-Z][a-z]+)*\b/g,
    )) {
      if (match[0].length > 2) {
        terms.add(match[0]);
      }
    }

    for (const word of item.observation.split(/\s+/)) {
      const cleaned = word.replace(/[^a-zA-Z0-9'-]/g, "");
      if (
        cleaned.length >= 4 &&
        !STOPWORDS.has(cleaned.toLowerCase()) &&
        !/^\d+$/.test(cleaned)
      ) {
        terms.add(cleaned);
      }
    }
  }

  return [...terms];
}

function findConcreteMatch(input: GenericGuardInput): string | null {
  const bodyLower = input.body.toLowerCase();

  const companyWords = input.companyName
    .split(/\s+/)
    .map((word) => word.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((word) => word.length > 3);
  for (const word of companyWords) {
    if (bodyLower.includes(word.toLowerCase())) {
      return `company name: "${word}"`;
    }
  }

  for (const tool of input.visibleTools) {
    const normalized = tool.trim().toLowerCase();
    if (
      normalized.length > 2 &&
      normalized !== "none_detected" &&
      bodyLower.includes(normalized)
    ) {
      return `tool: "${tool}"`;
    }
  }

  const numbers = extractNumeralsFromText(
    [input.problemHypothesis, ...input.evidence.map((e) => e.observation)].join(
      " ",
    ),
  );
  for (const num of numbers) {
    if (input.body.includes(num)) {
      return `number: "${num}"`;
    }
  }

  for (const term of extractEvidenceTerms(input.evidence)) {
    if (bodyLower.includes(term.toLowerCase())) {
      return `evidence noun: "${term}"`;
    }
  }

  return null;
}

function checkFabricatedProof(
  body: string,
  proofPoint: string | null,
): GenericGuardResult | { ok: true } {
  if (proofPoint?.trim()) {
    return { ok: true };
  }

  const bodyLower = body.toLowerCase();
  for (const pattern of CLIENT_CLAIM_PATTERNS) {
    if (bodyLower.includes(pattern)) {
      return {
        ok: false,
        reason: `client claim without proof_point: "${pattern}"`,
      };
    }
  }

  return { ok: true };
}

export function checkGenericDraft(input: GenericGuardInput): GenericGuardResult {
  const bodyLower = input.body.toLowerCase();

  for (const phrase of BANNED_PHRASES) {
    if (bodyLower.includes(phrase)) {
      return { ok: false, reason: `banned phrase: "${phrase}"` };
    }
  }

  const proofCheck = checkFabricatedProof(input.body, input.proofPoint);
  if (!proofCheck.ok) {
    return proofCheck;
  }

  const numberCheck = checkInventedNumbers(input.body, input.numberSourceTexts);
  if (!numberCheck.ok) {
    return numberCheck;
  }

  const matched = findConcreteMatch(input);
  if (!matched) {
    return {
      ok: false,
      reason:
        "missing concrete anchor (company name, tool, number, or evidence proper noun)",
    };
  }

  console.info(`[draft] generic guard passed — matched ${matched}`);
  return { ok: true, matched };
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
