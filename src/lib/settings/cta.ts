import type { z } from "zod";

import { ctaVariantsSchema } from "@/lib/validation/jsonb";

export type CtaVariants = z.infer<typeof ctaVariantsSchema>;

export function getActiveCtaText(ctaVariants: CtaVariants): string {
  const active = ctaVariants.variants.filter((variant) => variant.active);
  if (active.length !== 1) {
    throw new Error(
      `cta_variants must have exactly one active variant (got ${active.length})`,
    );
  }
  return active[0]!.text;
}

/**
 * The active variant's approved offer lines (09 §U6b). Empty when the variant
 * has none, in which case the claim guard refuses every offer claim.
 */
export function getApprovedOfferLines(ctaVariants: CtaVariants): string[] {
  const active = ctaVariants.variants.find((variant) => variant.active);
  return active?.approved_lines ?? [];
}

export function interpolateWriterPrompt(
  promptTemplate: string,
  ctaText: string,
): string {
  return promptTemplate.replace(/\{\{cta\}\}/g, ctaText);
}
