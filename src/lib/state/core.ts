import type { SupabaseClient } from "@supabase/supabase-js";

import { leadEventDetailSchema } from "@/lib/validation/jsonb";
import { parseOrThrow } from "@/lib/validation";
import {
  canTransition,
  leadStateSchema,
  type LeadState,
} from "@/types/enums";
import type { Database, Json } from "@/types/database";
import type { DatabaseWithTransitionRpc } from "@/types/database-rpc";

export type LeadRow = Database["public"]["Tables"]["leads"]["Row"];

type TransitionLeadArgs = {
  p_lead_id: string;
  p_from: string;
  p_to: string;
  p_event: string;
  p_detail?: Json;
  p_next_action?: string | null;
};

/** Thrown when a transition violates the state machine (before DB is touched). */
export class IllegalTransitionError extends Error {
  readonly fromState: LeadState;
  readonly toState: LeadState;

  constructor(fromState: LeadState, toState: LeadState) {
    super(`Illegal transition: ${fromState} → ${toState}`);
    this.name = "IllegalTransitionError";
    this.fromState = fromState;
    this.toState = toState;
  }
}

/** Base error for state transition failures (RPC, stale state, not found). */
export class TransitionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransitionError";
  }
}

function parseLeadState(value: string, label: string): LeadState {
  const result = leadStateSchema.safeParse(value);
  if (!result.success) {
    throw new TransitionError(`Invalid ${label} state: ${value}`);
  }
  return result.data;
}

export function createStateStore(db: SupabaseClient<Database>) {
  async function getLead(leadId: string): Promise<LeadRow> {
    const { data, error } = await db
      .from("leads")
      .select("*")
      .eq("id", leadId)
      .maybeSingle();

    if (error) {
      throw new TransitionError(`Failed to fetch lead ${leadId}: ${error.message}`);
    }
    if (!data) {
      throw new TransitionError(`Lead not found: ${leadId}`);
    }
    return data;
  }

  async function transition(
    leadId: string,
    from: LeadState,
    to: LeadState,
    event: string,
    detail?: Record<string, unknown>,
    nextActionAt?: string | null,
  ): Promise<LeadRow> {
    parseLeadState(from, "from");
    parseLeadState(to, "to");

    if (!canTransition(from, to)) {
      throw new IllegalTransitionError(from, to);
    }

    const parsedDetail = detail
      ? (parseOrThrow(
          leadEventDetailSchema,
          detail,
          `state:transition:${leadId}`,
        ) as Json)
      : ({} as Json);

    const args: TransitionLeadArgs = {
      p_lead_id: leadId,
      p_from: from,
      p_to: to,
      p_event: event,
      p_detail: parsedDetail,
      p_next_action: nextActionAt ?? null,
    };

    const { data, error } = await (
      db as SupabaseClient<DatabaseWithTransitionRpc>
    ).rpc("transition_lead", args);

    if (error) {
      throw new TransitionError(
        `transition_lead RPC failed for ${leadId} (${from} → ${to}): ${error.message}`,
        { cause: error },
      );
    }
    if (!data) {
      throw new TransitionError(
        `transition_lead RPC returned no row for ${leadId} (${from} → ${to})`,
      );
    }

    return data;
  }

  return { getLead, transition };
}
