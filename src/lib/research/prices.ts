// Research cost estimation (09 §UR). Pure.
//
// Prices are the Apify FREE-tier pay-per-event prices, read 2026-09-26 from
// the public actor objects `GET https://api.apify.com/v2/acts/<owner>~<name>`
// (`pricingInfos[-1].pricingPerEvent.actorChargeEvents`, FREE tier), and
// cross-checked on the store pages https://apify.com/<owner>/<name>. Paid
// plans are cheaper, so these are upper bounds. "Actor Start" is charged
// "one event per GB, minimum one event", so start = $0.00005 × the actor's
// default memory in GB (from the same object's `defaultRunOptions`).
//
// null = unknown (never 0 for unknown): apify/website-content-crawler has no
// pricingInfos (the store says "Pay per usage" — platform compute only), so a
// blog run's cost is unknown until Wave 2 measures one.

import type { EvidenceSourceType } from "@/types/enums";

export const PRICE_TABLE_SOURCE =
  "Apify actor objects (api.apify.com/v2/acts/<actor>, pricingInfos FREE tier + defaultRunOptions), read 2026-09-26";

type Price = {
  actorId: string;
  /** Fixed cost of one run (start events + fixed per-run add-ons). */
  perRunUsd: number;
  /** Per dataset item charged (post / job / article / profile / review). */
  perItemUsd: number;
  /** Charged instead of items when a query returns nothing (harvestapi "0-result query"). */
  zeroResultUsd?: number;
  /**
   * The actor's `minimalMaxTotalChargeUsd`: a run whose maxTotalChargeUsd is
   * lower is not started (the platform minimum; we skip rather than guess).
   */
  minMaxTotalChargeUsd?: number;
};

export const RESEARCH_PRICES: Record<EvidenceSourceType, Price | null> = {
  // harvestapi/linkedin-profile-posts: start $0.00005 (256 MB → 1 event), post $0.002,
  // 0-result query $0.001; minimalMaxTotalChargeUsd 0.002.
  li_person_post: { actorId: "harvestapi/linkedin-profile-posts", perRunUsd: 0.00005, perItemUsd: 0.002, zeroResultUsd: 0.001, minMaxTotalChargeUsd: 0.002 },
  li_company_post: { actorId: "harvestapi/linkedin-profile-posts", perRunUsd: 0.00005, perItemUsd: 0.002, zeroResultUsd: 0.001, minMaxTotalChargeUsd: 0.002 },
  // harvestapi/linkedin-profile-scraper: "Profile details" $0.004 (no start event listed).
  li_profile: { actorId: "harvestapi/linkedin-profile-scraper", perRunUsd: 0, perItemUsd: 0.004 },
  // bebity/linkedin-jobs-scraper: start $0.00005 × 2 (2048 MB), "Job result" $0.0015.
  // companyProfile/enrichCompany add-ons are switched off in the input.
  job_post: { actorId: "bebity/linkedin-jobs-scraper", perRunUsd: 0.0001, perItemUsd: 0.0015 },
  // compass/crawler-google-places: start $0.00005 × 4 (4096 MB), "Scraped place" $0.004,
  // "Additional place details scraped" $0.002 (applies to each place scraped for reviews),
  // "Review scraped" $0.0005; minimalMaxTotalChargeUsd 0.5. One place per run.
  google_review: {
    actorId: "compass/crawler-google-places",
    perRunUsd: 0.0002 + 0.004 + 0.002,
    perItemUsd: 0.0005,
    minMaxTotalChargeUsd: 0.5,
  },
  // data_xplorer/google-news-scraper-fast: "result" $0.004, no start event.
  news: { actorId: "data_xplorer/google-news-scraper-fast", perRunUsd: 0, perItemUsd: 0.004 },
  // apify/website-content-crawler: no pay-per-event price (platform usage) → unknown.
  blog: null,
};

function round5(n: number): number {
  return Math.round(n * 100_000) / 100_000;
}

/** Worst-case estimate before a run: every requested item is returned. null = unknown. */
export function estimateMaxCostUsd(source: EvidenceSourceType, maxItems: number): number | null {
  const price = RESEARCH_PRICES[source];
  if (!price) return null;
  return round5(price.perRunUsd + Math.max(maxItems * price.perItemUsd, price.zeroResultUsd ?? 0));
}

/** Estimate after a run from what the actor returned (the charged items). null = unknown. */
export function estimateActualCostUsd(source: EvidenceSourceType, chargedItems: number): number | null {
  const price = RESEARCH_PRICES[source];
  if (!price) return null;
  const items = chargedItems === 0 && price.zeroResultUsd !== undefined ? price.zeroResultUsd : chargedItems * price.perItemUsd;
  return round5(price.perRunUsd + items);
}

/**
 * What a run can cost at most, for the per-lead cap: the estimate, bounded by
 * the provider-side cap (maxTotalChargeUsd) when known; the provider cap
 * itself when the price is unknown.
 */
export function capExposureUsd(estimate: number | null, maxChargeUsd: number): number {
  return estimate === null ? maxChargeUsd : Math.min(estimate, maxChargeUsd);
}
