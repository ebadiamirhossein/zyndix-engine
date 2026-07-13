import type { Database, Json } from "@/types/database";

type LeadRow = Database["public"]["Tables"]["leads"]["Row"];

/** RPC signatures not yet in generated database.ts (apply 0002 migration, then gen:types). */
export type DatabaseWithTransitionRpc = Database & {
  public: Database["public"] & {
    Functions: {
      transition_lead: {
        Args: {
          p_lead_id: string;
          p_from: string;
          p_to: string;
          p_event: string;
          p_detail?: Json;
          p_next_action?: string | null;
        };
        Returns: LeadRow;
      };
    };
  };
};
