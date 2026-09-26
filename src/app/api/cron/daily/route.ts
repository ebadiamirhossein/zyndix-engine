import { runDaily } from "@/lib/orchestrator/daily";
import { handleCronRequest } from "@/lib/orchestrator/run";
import { createDailyDeps } from "@/lib/orchestrator/server";

// Vercel cron, once a day (UTC, vercel.json): ramp_stage and bounce_rate_7d
// per send account. Idempotent.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  return handleCronRequest(req, () => runDaily(createDailyDeps()));
}
