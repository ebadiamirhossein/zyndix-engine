/**
 * Proposed us-realestate.apollo_query (settings v3) — printed for approval before --apply.
 * Dry run: pnpm tsx scripts/update-segment-query.ts [--dry-run]
 * Apply (after approval): pnpm tsx scripts/update-segment-query.ts --apply
 */
export const PROPOSED_US_REALESTATE_APOLLO_QUERY = {
  industry: ["real estate brokerage", "residential real estate"],
  employee_range: ["5-20", "21-50"],
  country: "US",
  exclude_keywords: [
    "recruiting",
    "recruitment",
    "staffing",
    "hotel",
    "hospitality",
    "resort",
    "job board",
    "onlinejobs",
    "journal",
    "publisher",
    "media",
    "news",
    "council",
    "association",
    "institute",
    "society",
    "software",
    "platform",
    "proptech",
  ],
  titles: [
    "owner",
    "broker",
    "managing broker",
    "principal broker",
    "broker owner",
    "founder",
    "managing partner",
  ],
} as const;
