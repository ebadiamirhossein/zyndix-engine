import type { Database, Json } from "@/types/database";
import type { AppRole, CapacityReservationState, JobState, OutboxOperation, OutboxState } from "@/types/enums";

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

type BaseTables = DatabaseWithJobs["public"]["Tables"];
type Ledger = BaseTables["capacity_ledger"];
type SendAccounts = BaseTables["send_accounts"];

type CapacityCounters = { reserved: number; accepted: number; failed: number; reconciled: number };

type CapacityReservationRowShape = {
  id: string;
  ledger_id: string;
  send_account_id: string;
  date: string;
  n: number;
  state: CapacityReservationState;
  reconciled_outcome: "sent" | "not_sent" | null;
  idempotency_key: string | null;
  settled_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/**
 * Columns, table and RPCs added in 0007_capacity_counters.sql and
 * 0007b_reserve_capacity.sql — merge into database.ts after gen:types.
 * Both RPCs return jsonb; ledger.ts Zod-parses the shape.
 */
export type DatabaseWithCapacity = Omit<DatabaseWithJobs, "public"> & {
  public: Omit<DatabaseWithJobs["public"], "Tables" | "Functions"> & {
    Tables: Omit<BaseTables, "capacity_ledger" | "send_accounts"> & {
      capacity_ledger: {
        Row: Ledger["Row"] & CapacityCounters;
        Insert: Ledger["Insert"] & Partial<CapacityCounters>;
        Update: Ledger["Update"] & Partial<CapacityCounters>;
        Relationships: Ledger["Relationships"];
      };
      send_accounts: {
        Row: SendAccounts["Row"] & { ramp_started_on: string | null };
        Insert: SendAccounts["Insert"] & { ramp_started_on?: string | null };
        Update: SendAccounts["Update"] & { ramp_started_on?: string | null };
        Relationships: SendAccounts["Relationships"];
      };
      capacity_reservations: {
        Row: CapacityReservationRowShape;
        Insert: Partial<CapacityReservationRowShape> &
          Pick<CapacityReservationRowShape, "ledger_id" | "send_account_id" | "date" | "n">;
        Update: Partial<CapacityReservationRowShape>;
        Relationships: [];
      };
    };
    Functions: DatabaseWithJobs["public"]["Functions"] & {
      reserve_capacity: {
        Args: {
          p_send_account_id: string;
          p_date: string;
          p_quota: number;
          p_n?: number;
          p_idempotency_key?: string;
        };
        Returns: Json;
      };
      settle_capacity: {
        Args: { p_reservation_id: string; p_outcome: string };
        Returns: Json;
      };
    };
  };
};

type CapTables = DatabaseWithCapacity["public"]["Tables"];
type Touches = CapTables["touches"];
type Leads = CapTables["leads"];
type SendAccountsCap = CapTables["send_accounts"];

type TouchApprovalColumns = {
  approval_hash: string | null;
  approval_snapshot: Json | null;
  approved_at: string | null;
  approved_by: string | null;
  idempotency_key: string | null;
};

export type OutboxRowShape = {
  id: string;
  touch_id: string;
  lead_id: string;
  send_account_id: string;
  channel: string;
  operation: OutboxOperation;
  idempotency_key: string;
  approval_hash: string;
  reservation_id: string | null;
  state: OutboxState;
  provider_campaign_id: string | null;
  provider_lead_id: string | null;
  provider_email_id: string | null;
  provider_thread_id: string | null;
  reply_to_email_id: string | null;
  uncertain_reason: string | null;
  fingerprint: Json | null;
  last_error: string | null;
  dispatch_count: number;
  dispatched_at: string | null;
  settled_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/**
 * Columns and table added in 0008_touch_approval_binding.sql and
 * 0008b_outbox.sql (09 §U5) — merge into database.ts after gen:types.
 */
export type DatabaseWithSending = Omit<DatabaseWithCapacity, "public"> & {
  public: Omit<DatabaseWithCapacity["public"], "Tables"> & {
    Tables: Omit<CapTables, "touches" | "leads" | "send_accounts"> & {
      touches: {
        Row: Touches["Row"] & TouchApprovalColumns;
        Insert: Touches["Insert"] & Partial<TouchApprovalColumns>;
        Update: Touches["Update"] & Partial<TouchApprovalColumns>;
        Relationships: Touches["Relationships"];
      };
      leads: {
        Row: Leads["Row"] & { send_account_id: string | null };
        Insert: Leads["Insert"] & { send_account_id?: string | null };
        Update: Leads["Update"] & { send_account_id?: string | null };
        Relationships: Leads["Relationships"];
      };
      send_accounts: {
        Row: SendAccountsCap["Row"] & { instantly_campaign_id: string | null };
        Insert: SendAccountsCap["Insert"] & { instantly_campaign_id?: string | null };
        Update: SendAccountsCap["Update"] & { instantly_campaign_id?: string | null };
        Relationships: SendAccountsCap["Relationships"];
      };
      outbox: {
        Row: OutboxRowShape;
        Insert: Partial<OutboxRowShape> &
          Pick<OutboxRowShape, "touch_id" | "lead_id" | "send_account_id" | "operation" | "idempotency_key" | "approval_hash">;
        Update: Partial<OutboxRowShape>;
        Relationships: [];
      };
    };
  };
};
