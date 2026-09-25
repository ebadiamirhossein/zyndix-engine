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

/** 0009_send_prereqs.sql (Session 12): HQ location, timezone provenance, signature. */
type LeadSendColumns = {
  send_account_id: string | null;
  timezone_source: string | null;
  timezone_derived_at: string | null;
};
type SendAccountSendColumns = { instantly_campaign_id: string | null; signature_text: string | null };
type CompanyHqColumns = {
  hq_state: string | null;
  hq_city: string | null;
  hq_location_source: string | null;
  hq_location_fetched_at: string | null;
};
type Companies = CapTables["companies"];

type TouchApprovalColumns = {
  approval_hash: string | null;
  approval_snapshot: Json | null;
  approved_at: string | null;
  approved_by: string | null;
  idempotency_key: string | null;
  /** 0009c_claim_ledger.sql (09 §U6b, Session 15). */
  claim_ledger: Json | null;
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
 * 0008b_outbox.sql (09 §U5), plus the columns of 0009_send_prereqs.sql
 * (Session 12) and touches.claim_ledger of 0009c_claim_ledger.sql (Session 15)
 * — merge into database.ts after gen:types.
 */
export type DatabaseWithSending = Omit<DatabaseWithCapacity, "public"> & {
  public: Omit<DatabaseWithCapacity["public"], "Tables"> & {
    Tables: Omit<CapTables, "touches" | "leads" | "send_accounts" | "companies"> & {
      companies: {
        Row: Companies["Row"] & CompanyHqColumns;
        Insert: Companies["Insert"] & Partial<CompanyHqColumns>;
        Update: Companies["Update"] & Partial<CompanyHqColumns>;
        Relationships: Companies["Relationships"];
      };
      touches: {
        Row: Touches["Row"] & TouchApprovalColumns;
        Insert: Touches["Insert"] & Partial<TouchApprovalColumns>;
        Update: Touches["Update"] & Partial<TouchApprovalColumns>;
        Relationships: Touches["Relationships"];
      };
      leads: {
        Row: Leads["Row"] & LeadSendColumns;
        Insert: Leads["Insert"] & Partial<LeadSendColumns>;
        Update: Leads["Update"] & Partial<LeadSendColumns>;
        Relationships: Leads["Relationships"];
      };
      send_accounts: {
        Row: SendAccountsCap["Row"] & SendAccountSendColumns;
        Insert: SendAccountsCap["Insert"] & Partial<SendAccountSendColumns>;
        Update: SendAccountsCap["Update"] & Partial<SendAccountSendColumns>;
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

type SendTables = DatabaseWithSending["public"]["Tables"];
type WebhookEvents = SendTables["webhook_events"];

export type ExceptionRowShape = {
  id: string;
  kind: string;
  provider: string | null;
  webhook_event_id: string | null;
  lead_id: string | null;
  detail: Json | null;
  status: "open" | "escalated" | "resolved";
  escalated_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/**
 * Table and column added in 0009b_exceptions.sql (09 §U6) — merge into
 * database.ts after gen:types.
 */
export type DatabaseWithWebhooks = Omit<DatabaseWithSending, "public"> & {
  public: Omit<DatabaseWithSending["public"], "Tables"> & {
    Tables: Omit<SendTables, "webhook_events"> & {
      webhook_events: {
        Row: WebhookEvents["Row"] & { processing_error: string | null };
        Insert: WebhookEvents["Insert"] & { processing_error?: string | null };
        Update: WebhookEvents["Update"] & { processing_error?: string | null };
        Relationships: WebhookEvents["Relationships"];
      };
      exceptions: {
        Row: ExceptionRowShape;
        Insert: Partial<ExceptionRowShape> & Pick<ExceptionRowShape, "kind">;
        Update: Partial<ExceptionRowShape>;
        Relationships: [];
      };
    };
  };
};
