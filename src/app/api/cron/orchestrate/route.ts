import { handleCronRequest, runOrchestrate } from "@/lib/orchestrator/run";
import { createCronDeps } from "@/lib/orchestrator/server";

// Vercel cron, every 5 minutes (vercel.json). Auth, pause and the drain live
// in lib/orchestrator/run.ts; this file only wires deps. run_budget_ms
// (orchestrator_budgets) must stay below maxDuration.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  return handleCronRequest(req, () => runOrchestrate(createCronDeps()));
}
