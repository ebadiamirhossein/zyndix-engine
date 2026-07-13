/** Allowed: Unicode letters, spaces, hyphens, apostrophes. */
const VALID_NAME_CHARS = /^[\p{L}\s'-]+$/u;

export function orgDomain(org: {
  primary_domain?: string | null;
  website_url?: string | null;
}): string | null {
  if (org.primary_domain?.trim()) {
    return org.primary_domain.toLowerCase().replace(/^www\./, "");
  }
  if (!org.website_url?.trim()) {
    return null;
  }
  try {
    const url = org.website_url.startsWith("http")
      ? org.website_url
      : `https://${org.website_url}`;
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function orgExcludedByKeywords(
  org: { name: string; primary_domain?: string | null; website_url?: string | null },
  domain: string | null,
  excludeKeywords: string[] | undefined,
): boolean {
  if (!excludeKeywords?.length) {
    return false;
  }
  const haystack = `${org.name} ${domain ?? ""} ${org.website_url ?? ""}`.toLowerCase();
  return excludeKeywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

export function looksTruncatedName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length <= 2) {
    return true;
  }
  if (trimmed.length === 3 && !/[aeiouAEIOU]/.test(trimmed)) {
    return true;
  }
  return false;
}

export function isValidPersonName(name: string | null | undefined): boolean {
  if (!name?.trim()) {
    return false;
  }
  const trimmed = name.trim();
  if (!VALID_NAME_CHARS.test(trimmed)) {
    return false;
  }
  if (looksTruncatedName(trimmed)) {
    return false;
  }
  return true;
}

export type NameFieldFailure = {
  field: "first_name" | "last_name";
  reason: "missing" | "invalid_characters" | "truncated";
  value: string | null;
};

function assessNameField(
  field: "first_name" | "last_name",
  name: string | null | undefined,
): NameFieldFailure | null {
  if (!name?.trim()) {
    return { field, reason: "missing", value: name ?? null };
  }
  const trimmed = name.trim();
  if (!VALID_NAME_CHARS.test(trimmed)) {
    return { field, reason: "invalid_characters", value: trimmed };
  }
  if (looksTruncatedName(trimmed)) {
    return { field, reason: "truncated", value: trimmed };
  }
  return null;
}

export function getPersonNameFailures(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): NameFieldFailure[] {
  return [
    assessNameField("first_name", firstName),
    assessNameField("last_name", lastName),
  ].filter((failure): failure is NameFieldFailure => failure !== null);
}

export function formatPersonNameFailureReason(failures: NameFieldFailure[]): string {
  return failures.map((f) => `${f.field}: ${f.reason}`).join("; ");
}

export type PersonNameAssessment = {
  firstNameValid: boolean;
  lastNameValid: boolean;
  nameSuspect: boolean;
  doNotContact: boolean;
  failures: NameFieldFailure[];
};

export function assessPersonNames(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): PersonNameAssessment {
  const failures = getPersonNameFailures(firstName, lastName);
  const firstNameValid = !failures.some((f) => f.field === "first_name");
  const lastNameValid = !failures.some((f) => f.field === "last_name");
  return {
    firstNameValid,
    lastNameValid,
    nameSuspect: failures.length > 0,
    doNotContact: !firstNameValid,
    failures,
  };
}
