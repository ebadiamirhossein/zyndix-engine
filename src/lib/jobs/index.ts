import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { db } from "@/lib/db";
import type { DatabaseWithJobs } from "@/types/database-extensions";

import { createJobQueue } from "./queue";

export * from "./backoff";
export * from "./queue";
export * from "./registry";
export * from "./worker";

/** App/API code enqueues and runs jobs through this queue; scripts build their own via createJobQueue. */
export const jobQueue = createJobQueue(db as unknown as SupabaseClient<DatabaseWithJobs>);
