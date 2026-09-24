import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { parseOrThrow } from "@/lib/validation";
import type { DatabaseWithCapacity } from "@/types/database-extensions";
import { capacityReservationStateSchema, type CapacityOutcome } from "@/types/enums";

type Db = SupabaseClient<DatabaseWithCapacity>;

// ---------------------------------------------------------------------------
// Atomic capacity ledger (09 §U3, brief §10). The counter semantics and the
// recovery table live in 0007_capacity_counters.sql's header; the atomic
// logic lives in 0007b's reserve_capacity() / settle_capacity(). This file
// only calls them and Zod-validates what comes back.
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int().nonnegative();

const reserveResultSchema = z.object({
  status: z.enum(["ok", "quota_exhausted"]),
  replayed: z.boolean(),
  reservation_id: z.string().uuid().nullable(),
  reservation_state: capacityReservationStateSchema.nullable(),
  ledger_id: z.string().uuid(),
  date: isoDate,
  quota: count.nullable(),
  used: count,
  reserved: count,
});

const settleResultSchema = z.object({
  status: z.enum(["ok", "already"]),
  reservation_id: z.string().uuid(),
  state: capacityReservationStateSchema,
  ledger_id: z.string().uuid(),
  quota: count.nullable(),
  used: count,
  reserved: count,
  accepted: count,
  failed: count,
  reconciled: count,
});

export const ledgerRowSchema = z.object({
  id: z.string().uuid(),
  send_account_id: z.string().uuid().nullable(),
  date: isoDate,
  quota: count.nullable(),
  used: count.nullable(),
  reserved: count,
  accepted: count,
  failed: count,
  reconciled: count,
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export const reservationRowSchema = z.object({
  id: z.string().uuid(),
  ledger_id: z.string().uuid(),
  send_account_id: z.string().uuid(),
  date: isoDate,
  n: z.number().int().positive(),
  state: capacityReservationStateSchema,
  reconciled_outcome: z.enum(["sent", "not_sent"]).nullable(),
  idempotency_key: z.string().nullable(),
  settled_at: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

export type LedgerRow = z.infer<typeof ledgerRowSchema>;
export type ReservationRow = z.infer<typeof reservationRowSchema>;
export type SettleResult = z.infer<typeof settleResultSchema>;

export type LedgerSnapshot = {
  ledgerId: string;
  date: string;
  quota: number | null;
  used: number;
  reserved: number;
};

export type ReserveInput = {
  sendAccountId: string;
  /** UTC ledger date, YYYY-MM-DD — see `ledgerDate()` in windows.ts. */
  date: string;
  /** The day's quota from `rampQuota()`. It can lower the day's quota, never raise it. */
  quota: number;
  n?: number;
  /** Stable per logical send: a re-run reserving again gets the first reservation back. */
  idempotencyKey?: string;
};

export type ReserveResult =
  | {
      ok: true;
      reservation: { id: string; state: ReservationRow["state"] };
      /** True when the idempotency key already held a reservation. Its state may no longer be `reserved`. */
      replayed: boolean;
      snapshot: LedgerSnapshot;
    }
  | { ok: false; reason: "quota_exhausted"; snapshot: LedgerSnapshot };

/** Storage or RPC failure — not a quota refusal, which is a normal result. */
export class CapacityLedgerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CapacityLedgerError";
  }
}

export function createCapacityLedger(db: Db) {
  async function reserve(input: ReserveInput): Promise<ReserveResult> {
    const { data, error } = await db.rpc("reserve_capacity", {
      p_send_account_id: input.sendAccountId,
      p_date: input.date,
      p_quota: input.quota,
      p_n: input.n ?? 1,
      ...(input.idempotencyKey ? { p_idempotency_key: input.idempotencyKey } : {}),
    });
    if (error) {
      throw new CapacityLedgerError(`reserve_capacity failed: ${error.message}`);
    }
    const r = parseOrThrow(reserveResultSchema, data, "capacity.reserve");
    const snapshot: LedgerSnapshot = {
      ledgerId: r.ledger_id,
      date: r.date,
      quota: r.quota,
      used: r.used,
      reserved: r.reserved,
    };
    if (r.status === "quota_exhausted") {
      return { ok: false, reason: "quota_exhausted", snapshot };
    }
    if (!r.reservation_id || !r.reservation_state) {
      throw new CapacityLedgerError("reserve_capacity returned ok without a reservation");
    }
    return {
      ok: true,
      reservation: { id: r.reservation_id, state: r.reservation_state },
      replayed: r.replayed,
      snapshot,
    };
  }

  /**
   * Move a reservation one step. Repeating a step that already happened is
   * `status: 'already'` with no counter change; an invalid transition throws.
   */
  async function settle(reservationId: string, outcome: CapacityOutcome): Promise<SettleResult> {
    const { data, error } = await db.rpc("settle_capacity", {
      p_reservation_id: reservationId,
      p_outcome: outcome,
    });
    if (error) {
      throw new CapacityLedgerError(`settle_capacity(${outcome}) failed: ${error.message}`);
    }
    return parseOrThrow(settleResultSchema, data, `capacity.settle.${outcome}`);
  }

  async function getDay(sendAccountId: string, date: string): Promise<LedgerRow | null> {
    const { data, error } = await db
      .from("capacity_ledger")
      .select("*")
      .eq("send_account_id", sendAccountId)
      .eq("date", date)
      .maybeSingle();
    if (error) {
      throw new CapacityLedgerError(`read ledger ${sendAccountId}/${date} failed: ${error.message}`);
    }
    return data ? parseOrThrow(ledgerRowSchema, data, "capacity.getDay") : null;
  }

  async function getReservation(id: string): Promise<ReservationRow | null> {
    const { data, error } = await db.from("capacity_reservations").select("*").eq("id", id).maybeSingle();
    if (error) {
      throw new CapacityLedgerError(`read reservation ${id} failed: ${error.message}`);
    }
    return data ? parseOrThrow(reservationRowSchema, data, "capacity.getReservation") : null;
  }

  return {
    reserve,
    settle,
    /** Refused before the provider call: capacity returns. */
    release: (id: string) => settle(id, "release"),
    /** Provider accepted and returned an id. */
    accept: (id: string) => settle(id, "accept"),
    /** Provider definitively rejected; nothing went out, capacity returns. */
    fail: (id: string) => settle(id, "fail"),
    /** Timeout after possible acceptance: capacity stays held until reconciled. Never resend. */
    markUncertain: (id: string) => settle(id, "uncertain"),
    reconcile: (id: string, outcome: "sent" | "not_sent") =>
      settle(id, outcome === "sent" ? "reconcile_sent" : "reconcile_not_sent"),
    getDay,
    getReservation,
  };
}

export type CapacityLedger = ReturnType<typeof createCapacityLedger>;
