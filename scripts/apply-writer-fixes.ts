import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";
import {
  compliance_footer,
  proof_points,
} from "../src/lib/settings/seed-content";
import { getActiveCtaText, interpolateWriterPrompt } from "../src/lib/settings/cta";
import type { CtaVariants } from "../src/lib/settings/cta";
import { interpolateComplianceFooter } from "../src/lib/settings/compliance";
import type { Json } from "../src/types/database";

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

const PROOF_BLOCK = `

PROOF (CRITICAL)
- If no proof_point is supplied, you MUST NOT reference any past client, result, or outcome — real or implied. Write the email with zero social proof. NEVER invent a client, a result, or a number. A fabricated proof destroys credibility permanently.
`;

function buildWriterPromptV3(basePrompt: string): string {
  let prompt = basePrompt.replace(
    /\n\nHARD CONTENT RULES \(non-negotiable\):[\s\S]*$/m,
    "",
  );

  prompt = prompt.replace(
    /INPUT: qualification JSON[\s\S]*?compliance requirements\./,
    `INPUT: qualification JSON (hypothesis, evidence, angle, segment), lead name/
title/company, proof_point (may be null), sequence step hint (e.g. "first touch" or
"attach_pdf").`,
  );

  prompt = prompt.replace(
    /- Sentence 2-3:[\s\S]*?(?=\n- CTA:)/,
    `- Sentence 2-3: what that problem usually costs (concrete: hours, lost leads,
  no-shows). If proof_point is supplied in input, ONE line may reference it.
  If proof_point is null, write with zero social proof.
`,
  );

  prompt = prompt.replace(
    /- CTA:[\s\S]*?(?=\n- ≤120 words body)/,
    "- CTA: {{cta}}\n",
  );

  if (!prompt.includes("PROOF (CRITICAL)")) {
    prompt = prompt.replace(
      /(- ≤120 words body\.[\s\S]*?\n)\n(FORBIDDEN)/,
      `$1${PROOF_BLOCK}\n$2`,
    );
  }

  prompt = prompt.replace(
    /- Claims without evidence\. Fake personalization \("love what you're doing!"\)\./,
    `- Claims without evidence. Fake personalization ("love what you're doing!").
- Any invented client story, outcome, or metric.`,
  );

  prompt = prompt.replace(
    /COMPLIANCE[\s\S]*?(?=OUTPUT STRICT JSON)/,
    `COMPLIANCE
- Do NOT include a physical address or opt-out line in the body. The system
  appends this footer automatically after generation:
  {{compliance_footer}}

`,
  );

  prompt = prompt.replace(
    /OUTPUT STRICT JSON:.*$/,
    'OUTPUT STRICT JSON: Return ONLY {"subject": "...", "body": "..."}. No other keys.',
  );

  const hardRules = `

HARD CONTENT RULES (non-negotiable):
1. Zyndix speaks for itself. NEVER mention Acavent or any prior employer. Credibility comes from the observed hypothesis, not borrowed authority.
2. The first sentence must name THEIR problem, drawn from qualification.problem_hypothesis and grounded in the evidence. No "we do AI automation" language. No generic openers.
`;

  return `${prompt.trimEnd()}${hardRules}`;
}

async function ensureSetting(
  key: string,
  value: unknown,
  changeNote: string,
): Promise<void> {
  const { data: existing } = await db
    .from("settings")
    .select("version")
    .eq("key", key)
    .eq("active", true)
    .maybeSingle();

  if (existing) {
    console.log(`${key} already active (v${existing.version})`);
    return;
  }

  const { error } = await db.from("settings").insert({
    key,
    version: 1,
    value: value as Json,
    active: true,
    changed_by: "amir",
    change_note: changeNote,
  });

  if (error) {
    throw new Error(`Failed to seed ${key}: ${error.message}`);
  }

  console.log(`SEED ${key} v1`);
}

async function main(): Promise<void> {
  const apply = hasFlag(process.argv.slice(2), "--apply");

  await ensureSetting(
    "proof_points",
    proof_points,
    "v1: us-realestate null; lt-events verifiable Zyndix work only",
  );
  await ensureSetting(
    "compliance_footer",
    compliance_footer,
    "v1: registered Vilnius address + opt-out",
  );

  const [ctaSetting, footerSetting] = await Promise.all([
    settings.getActiveSetting("cta_variants"),
    settings.getActiveSetting("compliance_footer"),
  ]);

  const current = await settings.getActiveSetting("writer_prompt_email");
  const proposedTemplate = buildWriterPromptV3(String(current.value));
  const withCta = interpolateWriterPrompt(
    proposedTemplate,
    getActiveCtaText(ctaSetting.value as CtaVariants),
  );
  const proposed = interpolateComplianceFooter(
    withCta,
    String(footerSetting.value),
  );

  console.log("=== Final writer_prompt_email v3 (runtime preview) ===\n");
  console.log(proposed);
  console.log("\n=== Stored template ({{cta}} + {{compliance_footer}}) ===\n");
  console.log(proposedTemplate);

  if (!apply) {
    console.log("\n(dry-run) Add --apply to write writer_prompt_email v3.");
    return;
  }

  const next = await settings.writeNewVersion(
    "writer_prompt_email",
    proposedTemplate,
    "amir",
    "no fabricated proof; settings CTA/footer; strict JSON; word-count retry",
  );

  console.log(`\nWROTE writer_prompt_email v${next.version} (active=true)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
