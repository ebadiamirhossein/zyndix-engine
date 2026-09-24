import type { Database, Json } from "@/types/database";
import type { AppRole, JobState } from "@/types/enums";

/** Table added in 0004_source_cursors.sql — merge into database.ts after gen:types. */
export type DatabaseWithSourceCursors = Database & {
  public: Database["public"] & {
    Tables: Database["public"]["Tables"] & {
      source_cursors: {
        Row: {
          segment_key: string;
          page: number;
          updated_at: string | null;
        };
        Insert: {
          segment_key: string;
          page?: number;
          updated_at?: string | null;
        };
        Update: {
          segment_key?: string;
          page?: number;
          updated_at?: string | null;
        };
        Relationships: [];
      };
    };
  };
};

/** Table added in 0005_app_users_roles.sql — merge into database.ts after gen:types. */
export type DatabaseWithAppUsers = DatabaseWithSourceCursors & {
  public: DatabaseWithSourceCursors["public"] & {
    Tables: DatabaseWithSourceCursors["public"]["Tables"] & {
      app_users: {
        Row: {
          id: string;
          user_id: string;
          email: string;
          role: AppRole;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          email: string;
          role?: AppRole;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          email?: string;
          role?: AppRole;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
    };
  };
};

type JobRowShape = {
  id: string;
  type: string;
  payload: Json;
  state: JobState;
  run_after: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  idempotency_key: string | null;
  finished_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/** Table added in 0006_jobs.sql and RPC added in 0006b_claim_jobs_rpc.sql — merge into database.ts after gen:types. */
export type DatabaseWithJobs = DatabaseWithAppUsers & {
  public: DatabaseWithAppUsers["public"] & {
    Tables: DatabaseWithAppUsers["public"]["Tables"] & {
      jobs: {
        Row: JobRowShape;
        Insert: Partial<JobRowShape> & { type: string };
        Update: Partial<JobRowShape>;
        Relationships: [];
      };
    };
    Functions: DatabaseWithAppUsers["public"]["Functions"] & {
      claim_jobs: {
        Args: {
          p_owner: string;
          p_types: string[];
          p_limit?: number;
          p_lease_seconds?: number;
        };
        Returns: JobRowShape[];
      };
    };
  };
};
