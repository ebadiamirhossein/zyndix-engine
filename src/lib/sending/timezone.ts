import { SINGLE_TIMEZONE_COUNTRIES } from "@/lib/sending/single-timezone-countries";

// Recipient timezone resolution for the send window (09 §U5; operator rule,
// Session 11). Order: the lead's own timezone, then the company's, then — only
// when the company's HQ country has exactly one IANA zone — that zone. Anything
// else is unknown, and preflight turns unknown into a `timezone_unknown` HOLD,
// never a deferral: without a zone there is no next window to defer to.

export type TimezoneSource = "lead" | "company" | "country_fallback";

export type ResolvedTimezone = { timeZone: string; source: TimezoneSource; country?: string };

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

function nameKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z]/g, "");
}

/** English country name (and common aliases) → ISO alpha-2, for the single-zone table only. */
const NAME_TO_CODE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const code of Object.keys(SINGLE_TIMEZONE_COUNTRIES)) {
    const name = REGION_NAMES.of(code);
    if (name) map.set(nameKey(name), code);
  }
  for (const [alias, code] of [
    ["uk", "GB"],
    ["greatbritain", "GB"],
    ["england", "GB"],
    ["scotland", "GB"],
    ["wales", "GB"],
    ["northernireland", "GB"],
    ["czechia", "CZ"],
    ["czechrepublic", "CZ"],
    ["holland", "NL"],
    ["thenetherlands", "NL"],
    ["southkorea", "KR"],
    ["korearepublicof", "KR"],
  ] as const) {
    map.set(alias, code);
  }
  return map;
})();

/** The single zone for a country given as ISO alpha-2 or an English name; null otherwise. */
export function singleTimezoneForCountry(country: string | null | undefined): { code: string; timeZone: string } | null {
  const raw = (country ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  // "UK" is two letters but not an ISO code, so an unknown code falls through to the aliases.
  const code = /^[A-Z]{2}$/.test(upper) && upper in SINGLE_TIMEZONE_COUNTRIES ? upper : NAME_TO_CODE.get(nameKey(raw));
  if (!code) return null;
  const timeZone = SINGLE_TIMEZONE_COUNTRIES[code];
  return timeZone ? { code, timeZone } : null;
}

export function resolveRecipientTimezone(input: {
  leadTimezone: string | null | undefined;
  companyTimezone: string | null | undefined;
  companyCountry: string | null | undefined;
}): ResolvedTimezone | null {
  const lead = input.leadTimezone?.trim();
  if (lead && isValidTimeZone(lead)) return { timeZone: lead, source: "lead" };
  const company = input.companyTimezone?.trim();
  if (company && isValidTimeZone(company)) return { timeZone: company, source: "company" };
  const fallback = singleTimezoneForCountry(input.companyCountry);
  if (fallback) return { timeZone: fallback.timeZone, source: "country_fallback", country: fallback.code };
  return null;
}
