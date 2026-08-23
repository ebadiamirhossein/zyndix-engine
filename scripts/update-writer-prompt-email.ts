import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";
import { cta_variants } from "../src/lib/settings/seed-content";
import { getActiveCtaText, interpolateWriterPrompt } from "../src/lib/settings/cta";
import type { CtaVariants } from "../src/lib/settings/cta";
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

const CTA_LINE =
  "- CTA: {{cta}}";

const RULE_BLOCK = `

HARD CONTENT RULES (non-negotiable):
1. Zyndix speaks for itself. NEVER mention Acavent or any prior employer. Credibility comes from the observed hypothesis, not borrowed authority.
2. The first sentence must name THEIR problem, drawn from qualification.problem_hypothesis and grounded in the evidence. No "we do AI automation" language. No generic openers.
` as const;

function buildWriterPromptV2(basePrompt: string): string {
  let prompt = basePrompt.replace(
    /\n\nHARD CONTENT RULES \(non-negotiable\):[\s\S]*$/m,
    "",
  );

  prompt = prompt.replace(
    /- CTA:[\s\S]*?(?=\n- ≤120 words body)/,
    `${CTA_LINE}\n`,
  );

  prompt = prompt.replace(
    /- step 4 \(\+14d\): one-line honest close \("If timing's wrong, no problem —\n  leaving this here\."\).*Nothing clever\./,
    `- step 4 (+14d): one-line honest close ("If timing's wrong, no problem —
  leaving this here.") + same CTA style as touch 1. Nothing clever.`,
  );

  return `${prompt.trimEnd()}${RULE_BLOCK}`;
}

async function ensureCtaVariants(): Promise<void> {
  const { data: existing } = await db
    .from("settings")
    .select("version")
    .eq("key", "cta_variants")
    .eq("active", true)
    .maybeSingle();

  if (existing) {
    console.log(`cta_variants already active (v${existing.version})`);
    return;
  }

  const { error } = await db.from("settings").insert({
    key: "cta_variants",
    version: 1,
    value: cta_variants as unknown as Json,
    active: true,
    changed_by: "amir",
    change_note: "v1: reply active (deliverability); link reserved for warm inboxes",
  });

  if (error) {
    throw new Error(`Failed to seed cta_variants: ${error.message}`);
  }

  console.log("SEED cta_variants v1 (reply active)");
}

async function main(): Promise<void> {
  const apply = hasFlag(process.argv.slice(2), "--apply");

  await ensureCtaVariants();
  const ctaSetting = await settings.getActiveSetting("cta_variants");
  const activeCta = getActiveCtaText(ctaSetting.value as CtaVariants);

  const current = await settings.getActiveSetting("writer_prompt_email");
  const proposedTemplate = buildWriterPromptV2(String(current.value));
  const proposed = interpolateWriterPrompt(proposedTemplate, activeCta);

  console.log("=== Final writer_prompt_email v2 (interpolated preview) ===\n");
  console.log(proposed);
  console.log("");
  console.log("=== Template stored in settings ({{cta}} placeholder) ===\n");
  console.log(proposedTemplate);
  console.log("");
  console.log(`Active CTA variant: ${activeCta.slice(0, 80)}…`);

  if (!apply) {
    console.log("(dry-run) Add --apply to write writer_prompt_email v2.");
    return;
  }

  const next = await settings.writeNewVersion(
    "writer_prompt_email",
    proposedTemplate,
    "amir",
    "no prior-employer refs; first sentence names their problem; CTA from settings",
  );

  console.log(`WROTE writer_prompt_email v${next.version} (active=true)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
