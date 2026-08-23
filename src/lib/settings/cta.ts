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

export function interpolateWriterPrompt(
  promptTemplate: string,
  ctaText: string,
): string {
  return promptTemplate.replace(/\{\{cta\}\}/g, ctaText);
}
