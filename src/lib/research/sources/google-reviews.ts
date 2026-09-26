// compass/crawler-google-places (09 §UR): the company's Google Maps reviews
// (google_review, per company).
//
// Input (input schema): searchStringsArray, locationQuery ("City + Country
// rather than City + Country + State" works best), maxCrawledPlacesPerSearch,
// maxReviews, reviewsSort enum newest | mostRelevant | highestRanking |
// lowestRanking, scrapeReviewsPersonalData (default TRUE: "personal data about
// the reviewer (their ID, name, URL, and photo URL) and about the review
// (URL)") — we set it false, so reviewer identities are never fetched and
// `reviewUrl` is absent; a review's source_url is then its place's Maps URL
// (the dedupe key still separates reviews by content hash).
// Output fields used (dataset schema / README): title, website, url, placeId,
// reviews[].{text, stars, publishedAtDate, reviewId, reviewUrl?}.
//
// A search by company name can return a different business: the place is
// kept ONLY when its `website` host is the company's domain. Otherwise zero
// items and a note.

import { z } from "zod";

import { createCollector, hostOf, hostMatchesDomain, httpUrl, isoDate, isTooOld, str, verbatimExcerpt } from "../text";
import type { ParseContext, ParseResult, SourceAdapter } from "../types";

const reviewSchema = z
  .object({
    text: z.string().optional().nullable(),
    stars: z.number().optional().nullable(),
    publishedAtDate: z.string().optional().nullable(),
    reviewId: z.string().optional().nullable(),
    reviewUrl: z.string().optional().nullable(),
  })
  .passthrough();

export const googlePlaceItemSchema = z
  .object({
    title: z.string().optional().nullable(),
    website: z.string().optional().nullable(),
    url: z.string().optional().nullable(),
    placeId: z.string().optional().nullable(),
    reviews: z.array(z.unknown()).optional().nullable(),
  })
  .passthrough();

export function parseGooglePlaces(items: unknown[], ctx: ParseContext): ParseResult {
  const c = createCollector(items.length);
  const domain = ctx.target.company.domain;
  for (const item of items) {
    const parsed = googlePlaceItemSchema.safeParse(item);
    if (!parsed.success) {
      c.drop("invalid_item");
      continue;
    }
    const place = parsed.data;
    const website = str(place.website);
    if (!website || !hostMatchesDomain(website, domain)) {
      c.drop("place_website_mismatch");
      c.note(
        `place "${place.title ?? "?"}" website ${website ? hostOf(website.includes("://") ? website : `https://${website}`) : "(none)"} ≠ company domain ${domain ?? "(none)"}: its reviews are not this company's`,
      );
      continue;
    }
    const placeUrl = httpUrl(place.url);
    for (const rawReview of place.reviews ?? []) {
      const r = reviewSchema.safeParse(rawReview);
      if (!r.success) {
        c.drop("invalid_item");
        continue;
      }
      const review = r.data;
      const url = httpUrl(review.reviewUrl) ?? placeUrl;
      if (!url) {
        c.drop("no_url");
        continue;
      }
      const text = str(review.text);
      if (!text) {
        c.drop("no_text"); // a star rating with no words is not evidence of anything specific
        continue;
      }
      const published = isoDate(review.publishedAtDate);
      if (isTooOld(published, ctx.now, ctx.maxItemAgeDays)) {
        c.drop("too_old");
        continue;
      }
      const excerpt = verbatimExcerpt(text);
      if (!excerpt) {
        c.drop("excerpt_unbounded");
        continue;
      }
      c.keep({
        source_type: "google_review",
        source_url: url,
        title: str(place.title),
        excerpt,
        published_at: published,
        // No reviewer name/id/photo: only the review's own id, stars and date.
        raw: { placeId: place.placeId ?? null, placeUrl, reviewId: review.reviewId ?? null, stars: review.stars ?? null, publishedAtDate: review.publishedAtDate ?? null },
      });
    }
  }
  return c.result();
}

/** Review count the actor charges for ("Review scraped" events). */
export function chargedReviews(items: unknown[]): number {
  let n = 0;
  for (const item of items) {
    const parsed = googlePlaceItemSchema.safeParse(item);
    if (parsed.success) n += parsed.data.reviews?.length ?? 0;
  }
  return n;
}

export const googleReviewAdapter: SourceAdapter = {
  sourceType: "google_review",
  scope: "company",
  templateKeys: ["reviews"],
  missingInput: (t) => {
    if (!t.company.domain) return "company has no domain to match the place against";
    if (!t.company.city) return "company has no city for the location query";
    return null;
  },
  buildInput: (t, policy, base) => ({
    ...base,
    searchStringsArray: [t.company.name],
    locationQuery: [t.company.city, t.company.country ?? "United States"].filter(Boolean).join(", "),
    maxCrawledPlacesPerSearch: 1,
    maxReviews: policy.max_items,
    reviewsSort: "newest",
    scrapeReviewsPersonalData: false,
    maxImages: 0,
    scrapeContacts: false,
    scrapePlaceDetailPage: false,
  }),
  // One place per run (the dataset item); reviews are nested in it.
  maxItems: () => 1,
  parse: parseGooglePlaces,
};
