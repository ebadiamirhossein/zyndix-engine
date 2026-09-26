import type { RegisteredJob } from "@/lib/jobs/registry";

import type { ResearchRunnerDeps } from "./run";

// 09 §UR (Wave 1 decision, UR agent): research runs INSIDE the enrich stage
// (runResearchForLeads over the enrich batch), not as a separate job. The
// batch plan already gives "one company-level run per source per company"
// and the reuse window covers later batches, so a `research.company` job
// (RESEARCH_COMPANY_JOB_TYPE in lib/jobs/types.ts) would add a second path
// with the same effect. The export stays so U9's registry compiles against a
// stable contract; it registers nothing.

export type ResearchDeps = ResearchRunnerDeps;

/** Job definitions for `research.company`: none (research runs inside enrich). */
export function researchJobDefinitions(deps: ResearchDeps): RegisteredJob[] {
  void deps;
  return [];
}
