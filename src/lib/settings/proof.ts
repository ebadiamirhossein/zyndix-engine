import type { z } from "zod";

import type { proofPointsSchema } from "@/lib/validation/jsonb";

export type ProofPoints = z.infer<typeof proofPointsSchema>;

export function getSegmentProofPoint(
  proofPoints: ProofPoints,
  segmentKey: string,
): string | null {
  const value = proofPoints[segmentKey];
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}
