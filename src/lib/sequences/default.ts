import type { SupabaseClient } from "@supabase/supabase-js";

import type { cadenceDefaultSchema } from "@/lib/validation/jsonb";
import type { Database } from "@/types/database";
import type { z } from "zod";

type CadenceDefault = z.infer<typeof cadenceDefaultSchema>;

const DEFAULT_SEQUENCE_NAME = "v1_default";

export async function ensureDefaultSequence(
  db: SupabaseClient<Database>,
  cadence: CadenceDefault,
  segment?: string | null,
): Promise<string> {
  const { data: existing } = await db
    .from("sequences")
    .select("id")
    .eq("name", DEFAULT_SEQUENCE_NAME)
    .eq("active", true)
    .maybeSingle();

  if (existing?.id) {
    return existing.id;
  }

  const { data: seq, error: seqError } = await db
    .from("sequences")
    .insert({
      name: DEFAULT_SEQUENCE_NAME,
      segment: segment ?? "default",
      channel: "email",
      active: true,
      version: 1,
    })
    .select("id")
    .single();

  if (seqError || !seq) {
    throw new Error(
      `Failed to create default sequence: ${seqError?.message ?? "no row"}`,
    );
  }

  const steps = cadence.steps.map((step) => ({
    sequence_id: seq.id,
    step_no: step.step,
    wait_days: step.wait_days,
    channel: step.channel,
    template_hint: step.hint,
    requires_approval: step.requires_approval,
  }));

  const { error: stepsError } = await db.from("sequence_steps").insert(steps);
  if (stepsError) {
    throw new Error(`Failed to seed sequence steps: ${stepsError.message}`);
  }

  return seq.id;
}
