// Pure helpers for the research parsers (09 §UR): verbatim excerpts, content
// hashes, URL and date normalisation. No I/O.

import { createHash } from "node:crypto";

import type { DropReason, EvidenceCandidate, ParseResult } from "./types";

/** Longest excerpt kept from one item (characters). Longer text is cut at a sentence boundary. */
export const MAX_EXCERPT_CHARS = 1200;

/**
 * A verbatim excerpt of `text`: the text itself (trimmed) when short enough;
 * otherwise cut at the last sentence boundary (". ", "! ", "? ", "…", or a
 * newline) at or before `max` characters — or, when there is none, at the
 * first boundary before 3×max. The result is ALWAYS a substring of `text`
 * (`text.includes(result)`), never re-spaced or re-worded. null when the
 * text is empty or no boundary exists within 3×max.
 */
export function verbatimExcerpt(text: string, max = MAX_EXCERPT_CHARS): string | null {
  const start = text.search(/\S/);
  if (start < 0) return null;
  const trimmed = text.slice(start).replace(/\s+$/, "");
  if (trimmed.length <= max) return trimmed;

  const boundaries: number[] = [];
  const re = /[.!?…](?=\s)|\n/g;
  for (const m of trimmed.matchAll(re)) {
    // End index (exclusive) of the kept text: include the punctuation, not the newline.
    boundaries.push(m[0] === "\n" ? m.index! : m.index! + m[0].length);
  }
  const within = boundaries.filter((end) => end > 0 && end <= max);
  let end = within.length > 0 ? within[within.length - 1]! : boundaries.find((b) => b > max && b <= max * 3);
  if (end === undefined) return null;
  let cut = trimmed.slice(0, end).replace(/\s+$/, "");
  // A cut that leaves almost nothing (a heading line) is not a useful excerpt; take the next boundary.
  if (cut.length < 40) {
    const next = boundaries.find((b) => b > end! && b <= max);
    if (next !== undefined) {
      end = next;
      cut = trimmed.slice(0, end).replace(/\s+$/, "");
    }
  }
  return cut.length > 0 ? cut : null;
}

/** sha256 of the normalised excerpt (lowercase, whitespace collapsed): the dedupe key's hash part. */
export function contentHash(excerpt: string): string {
  const normalized = excerpt.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** A public http(s) URL, or null. */
export function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** The host is the company domain or one of its subdomains. */
export function hostMatchesDomain(url: string, domain: string | null): boolean {
  if (!domain) return false;
  const host = hostOf(url.includes("://") ? url : `https://${url}`);
  const d = domain.replace(/^www\./, "").toLowerCase();
  return host.length > 0 && (host === d || host.endsWith(`.${d}`));
}

/**
 * The identity part of a LinkedIn URL: "in/<slug>" or "company/<slug>"
 * (lowercase, query and trailing segments dropped), or null. Author URLs
 * carry a `?miniProfileUrn=` query (actor README example), so the query
 * never matters.
 */
export function linkedinIdentity(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const kind = parts[0]?.toLowerCase();
    const slug = parts[1] ? decodeURIComponent(parts[1]).toLowerCase() : null;
    if (!slug || (kind !== "in" && kind !== "company" && kind !== "school" && kind !== "showcase")) return null;
    return `${kind === "in" ? "in" : "company"}/${slug}`;
  } catch {
    return null;
  }
}

/** ISO timestamp from an ISO string, a YYYY-MM-DD date, or an epoch (ms); null otherwise. */
export function isoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null; // relative strings ("3 days ago") are not dates
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isTooOld(publishedAt: string | null, now: Date, maxAgeDays: number): boolean {
  if (!publishedAt) return false;
  const age = (now.getTime() - Date.parse(publishedAt)) / 86_400_000;
  return Number.isFinite(age) && age > maxAgeDays;
}

const LEGAL_SUFFIX_RE = /[,\s]+(?:inc|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|plc|pllc|lp|llp)\.?$/i;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The text names the company: its full name, or its name without a legal
 * suffix ("Acme Realty LLC" → "Acme Realty"), as whole words, any case.
 */
export function namesCompany(text: string, companyName: string): boolean {
  const names = new Set<string>();
  const full = companyName.trim();
  if (full.length >= 3) names.add(full);
  const bare = full.replace(LEGAL_SUFFIX_RE, "").trim();
  if (bare.length >= 3) names.add(bare);
  for (const name of names) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(name).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu");
    if (re.test(text)) return true;
  }
  return false;
}

/** Collects candidates and drop counts for one parse; dedupes by content hash + URL. */
export function createCollector(rawCount: number) {
  const result: ParseResult = { candidates: [], drops: {}, rawCount, notes: [] };
  const seen = new Set<string>();
  const drop = (reason: DropReason, n = 1) => {
    result.drops[reason] = (result.drops[reason] ?? 0) + n;
  };
  return {
    drop,
    note(text: string) {
      result.notes.push(text);
    },
    keep(candidate: EvidenceCandidate) {
      const key = `${candidate.source_url}|${contentHash(candidate.excerpt)}`;
      if (seen.has(key)) {
        drop("duplicate");
        return;
      }
      seen.add(key);
      result.candidates.push(candidate);
    },
    result(): ParseResult {
      return result;
    },
  };
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
