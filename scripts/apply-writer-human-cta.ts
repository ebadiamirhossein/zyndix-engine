import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createSettingsStore } from "../src/lib/settings/core";
import {
  compliance_footer,
  cta_variants,
  writer_prompt_email,
} from "../src/lib/settings/seed-content";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

import { createServiceClient } from "../src/lib/db/service-client";

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

  const writerPrompt = `${writer_prompt_email.trimEnd()}${HARD_RULES}`;

  console.log("=== cta_variants v2 (reply active) ===\n");
  console.log(JSON.stringify(cta_variants, null, 2));
  console.log("\n=== compliance_footer v2 ===\n");
  console.log(compliance_footer);
  console.log("\n=== writer_prompt_email (CTA human rule) ===\n");
  console.log(writerPrompt);

  if (!apply) {
    console.log("\n(dry-run) Add --apply to write all three settings versions.");
    return;
  }

  const cta = await settings.writeNewVersion(
    "cta_variants",
    cta_variants,
    "amir",
    "natural human CTA questions; no reply-keyword autoresponder",
  );
  const footer = await settings.writeNewVersion(
    "compliance_footer",
    compliance_footer,
    "amir",
    "signature block format for CAN-SPAM",
  );
  const writer = await settings.writeNewVersion(
    "writer_prompt_email",
    writerPrompt,
    "amir",
    "human CTA rule; no reply-with-keyword language",
  );

  console.log(`\nWROTE cta_variants v${cta.version}`);
  console.log(`WROTE compliance_footer v${footer.version}`);
  console.log(`WROTE writer_prompt_email v${writer.version}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
