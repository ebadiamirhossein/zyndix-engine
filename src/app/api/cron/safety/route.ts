import { handleCronRequest, runSafety } from "@/lib/orchestrator/run";
import { createCronDeps } from "@/lib/orchestrator/server";

// Vercel cron, every 5 minutes offset from orchestrate (vercel.json). The
// stop-path jobs: recipient check, send reconcile, stale-stop, reply poll and
// the Instantly lead sweep. Runs during the global pause (06 §5, Wave 1).
// safety_budget_ms (orchestrator_budgets) must stay below maxDuration.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  return handleCronRequest(req, () => runSafety(createCronDeps()));
}
