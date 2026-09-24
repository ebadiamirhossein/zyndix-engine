import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { db } from "@/lib/db";
import type { DatabaseWithCapacity } from "@/types/database-extensions";

import { createCapacityLedger } from "./ledger";

export * from "./ledger";
export * from "./windows";

/** App/API code reserves capacity through this ledger; scripts build their own via createCapacityLedger. */
export const capacityLedger = createCapacityLedger(db as unknown as SupabaseClient<DatabaseWithCapacity>);
