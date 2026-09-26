// harvestapi/linkedin-profile-scraper (09 §UR): the lead's own LinkedIn
// profile (li_profile, per lead). Mode "Profile details no email ($4 per 1k)"
// (input schema enum). No cookies (store page: the tool "does not require
// cookies or account authentication").
//
// Output fields used (README example): linkedinUrl, headline, about,
// currentPosition[].companyName, experience[].{position, companyName,
// description}. A profile has no publication date: published_at is null.

import { z } from "zod";

import { createCollector, httpUrl, linkedinIdentity, str, verbatimExcerpt } from "../text";
import type { ParseContext, ParseResult, SourceAdapter } from "../types";

export const PROFILE_SCRAPER_MODE = "Profile details no email ($4 per 1k)";

const experienceSchema = z
  .object({
    position: z.string().optional().nullable(),
    companyName: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
  })
  .passthrough();

export const linkedinProfileItemSchema = z
  .object({
    linkedinUrl: z.string().optional().nullable(),
    headline: z.string().optional().nullable(),
    about: z.string().optional().nullable(),
    currentPosition: z.array(z.object({ companyName: z.string().optional().nullable() }).passthrough()).optional().nullable(),
    experience: z.array(experienceSchema).optional().nullable(),
  })
  .passthrough();

export function parseLinkedinProfile(items: unknown[], ctx: ParseContext): ParseResult {
  const c = createCollector(items.length);
  const target = linkedinIdentity(ctx.target.leadLinkedinUrl);
  for (const item of items) {
    const parsed = linkedinProfileItemSchema.safeParse(item);
    if (!parsed.success) {
      c.drop("invalid_item");
      continue;
    }
    const profile = parsed.data;
    const url = httpUrl(profile.linkedinUrl);
    if (!url) {
      c.drop("no_url");
      continue;
    }
    if (!target || linkedinIdentity(url) !== target) {
      c.drop("other_author");
      continue;
    }

    const texts: { title: string; text: string | null; raw: Record<string, unknown> }[] = [
      { title: "LinkedIn headline", text: str(profile.headline), raw: { field: "headline" } },
      { title: "LinkedIn about", text: str(profile.about), raw: { field: "about" } },
    ];
    // The current role's own description (the first experience at a current company).
    const current = new Set((profile.currentPosition ?? []).map((p) => p.companyName?.trim().toLowerCase()).filter(Boolean));
    const role = (profile.experience ?? []).find((e) => e.companyName && current.has(e.companyName.trim().toLowerCase()) && str(e.description));
    if (role) {
      texts.push({
        title: [role.position, role.companyName].filter(Boolean).join(" · ") || "LinkedIn current role",
        text: str(role.description),
        raw: { field: "experience.description", position: role.position ?? null, companyName: role.companyName ?? null },
      });
    }

    if (texts.every((t) => !t.text)) {
      c.drop("no_text");
      continue;
    }
    for (const t of texts) {
      if (!t.text) continue;
      const excerpt = verbatimExcerpt(t.text);
      if (!excerpt) {
        c.drop("excerpt_unbounded");
        continue;
      }
      c.keep({
        source_type: "li_profile",
        source_url: url,
        title: t.title,
        excerpt,
        published_at: null,
        raw: { linkedinUrl: url, ...t.raw },
      });
    }
  }
  return c.result();
}

export const liProfileAdapter: SourceAdapter = {
  sourceType: "li_profile",
  scope: "lead",
  templateKeys: ["li_profile"],
  missingInput: (t) => (linkedinIdentity(t.leadLinkedinUrl)?.startsWith("in/") ? null : "lead has no LinkedIn profile URL"),
  buildInput: (t, _policy, base) => ({
    ...base,
    profileScraperMode: PROFILE_SCRAPER_MODE,
    urls: [t.leadLinkedinUrl!],
  }),
  // One profile per run.
  maxItems: () => 1,
  parse: parseLinkedinProfile,
};
