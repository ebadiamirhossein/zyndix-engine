import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";
import { writer_prompt_email } from "../src/lib/settings/seed-content";
import { getActiveCtaText, interpolateWriterPrompt } from "../src/lib/settings/cta";
import type { CtaVariants } from "../src/lib/settings/cta";
import { interpolateComplianceFooter } from "../src/lib/settings/compliance";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const settings = createSettingsStore(db);

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

const HARD_RULES = `

HARD CONTENT RULES (non-negotiable):
1. Zyndix speaks for itself. NEVER mention Acavent or any prior employer. Credibility comes from the observed hypothesis, not borrowed authority.
2. The first sentence must name THEIR problem, drawn from qualification.problem_hypothesis and grounded in the evidence. No "we do AI automation" language. No generic openers.
`;

async function main(): Promise<void> {
  const apply = hasFlag(process.argv.slice(2), "--apply");

  const prompt = `${writer_prompt_email.trimEnd()}${HARD_RULES}`;

  const [ctaSetting, footerSetting] = await Promise.all([
    settings.getActiveSetting("cta_variants"),
    settings.getActiveSetting("compliance_footer"),
  ]);

  const withCta = interpolateWriterPrompt(
    prompt,
    getActiveCtaText(ctaSetting.value as CtaVariants),
  );
  const preview = interpolateComplianceFooter(
    withCta,
    String(footerSetting.value),
  );

  console.log("=== writer_prompt_email (clean) preview ===\n");
  console.log(preview);

  if (!apply) {
    console.log("\n(dry-run) Add --apply to write v5.");
    return;
  }

  const next = await settings.writeNewVersion(
    "writer_prompt_email",
    prompt,
    "amir",
    "no invented numbers; evidence-only numerals (fix corrupted v5)",
  );

  console.log(`\nWROTE writer_prompt_email v${next.version} (active=true)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
