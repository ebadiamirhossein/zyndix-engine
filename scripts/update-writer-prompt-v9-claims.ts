/**
 * scripts/update-writer-prompt-v9-claims.ts — 09 §U6b (Session 15).
 *
 * Writes three versioned settings, all or nothing per run:
 *   - writer_prompt_email v9: v8 + a claim ledger in the output, evidence ids,
 *     no timings, no asset claims, the approved offer line verbatim.
 *   - cta_variants v3: the active "reply" variant becomes the one approved line
 *     (operator decision, Session 15) and carries it as `approved_lines`.
 *   - evidence_policy v1: { max_age_days: 30 }.
 *
 * Default is a dry run that prints the new values. `--apply` writes them.
 * Guards: refuses unless the active versions are the ones this was written
 * against (writer v8, cta v2, no evidence_policy), so it cannot clobber a
 * newer edit.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createServiceClient(url, key);
const settings = createSettingsStore(db);

export const APPROVED_OFFER_LINE = "Happy to write up what I'd change, if that's useful.";
const CHANGED_BY = "session-15-u6b";

const CLAIMS_BLOCK = `CLAIMS (a deterministic checker reads these; a draft that fails it never reaches anyone)
- List every factual statement in the subject and body as a claim:
  {"span": "<text copied exactly from the subject or body>", "kind": "prospect_fact | inference | offer | question", "evidence_ids": ["E2"]}
- prospect_fact: something their site or profile states. Cite the evidence item(s) that state it.
  Every number, name, place, tool and quote in it must appear in that evidence.
- inference: what you conclude from the evidence. Cite the evidence it rests on.
- question: a question to them. Cite evidence if it mentions any fact.
- offer: the closing line only. evidence_ids is [].
- Every number, money amount, person, place or company name, and tool or vendor name in the
  subject or body must sit inside a claim span. Capitalise proper nouns, in the subject too.
- Spans are copied character for character. Never paraphrase inside a span.
- NEVER write a weekday, a time of day, "overnight", "after hours", "weekend", "tonight", or any
  response delay. No public page shows how fast they answer.
- NEVER say you have prepared, mapped out, put together, drafted, built, written up or attached
  anything. Nothing has been prepared.
- If evidence items disagree about something (for example a chat widget, a booking link, or a
  contact form), do not mention that thing at all.
- Do not cite an evidence item that describes a failed or unavailable fetch.
- If you cannot ground a sentence in the evidence, leave the sentence out.`;

function replaceOnce(text: string, from: string | RegExp, to: string, label: string): string {
  const found = typeof from === "string" ? text.includes(from) : from.test(text);
  if (!found) throw new Error(`v8 anchor not found: ${label}`);
  return text.replace(from, to);
}

export function buildWriterPromptV9(v8: string): string {
  let p = v8;
  p = replaceOnce(
    p,
    /INPUT: qualification JSON \(hypothesis, evidence, angle, segment\), lead name\/\ntitle\/company,/,
    "INPUT: qualification JSON (hypothesis, evidence, angle, segment; each evidence item has an id\nE1, E2, …), lead name/title/company,",
    "INPUT",
  );
  p = replaceOnce(
    p,
    /- Sentence 2-3: what that problem usually costs \(concrete: hours, lost leads,\n  no-shows\)\./,
    "- Sentence 2-3: what that problem costs them, described as a mechanism (who waits,\n  what gets missed). Never a time of day, a weekday or a response delay.",
    "Sentence 2-3",
  );
  p = replaceOnce(
    p,
    'OUTPUT STRICT JSON: Return ONLY {"subject": "...", "body": "..."}. No other keys.',
    `${CLAIMS_BLOCK}\n\nOUTPUT STRICT JSON: Return ONLY {"subject": "...", "body": "...", "claims": [...]}. No other keys.`,
    "OUTPUT",
  );
  return p;
}

export function buildCtaVariantsV3(v2: { variants: { id: string; active: boolean; text: string }[] }) {
  return {
    variants: v2.variants.map((variant) =>
      variant.id === "reply"
        ? {
            id: "reply",
            active: true,
            text: `end with exactly this sentence, verbatim, as its own line: "${APPROVED_OFFER_LINE}" Tag it as the one offer claim. No other offer, pitch or call request anywhere in the email.`,
            approved_lines: [APPROVED_OFFER_LINE],
          }
        : { ...variant, active: false },
    ),
  };
}

async function active(keyName: string): Promise<{ version: number; value: unknown } | null> {
  const { data, error } = await db.from("settings").select("version, value").eq("key", keyName).eq("active", true).maybeSingle();
  if (error) throw new Error(`read ${keyName}: ${error.message}`);
  return data;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const [writer, cta, policy] = await Promise.all([active("writer_prompt_email"), active("cta_variants"), active("evidence_policy")]);

  if (writer?.version !== 8) throw new Error(`writer_prompt_email is v${writer?.version}, expected v8`);
  if (cta?.version !== 2) throw new Error(`cta_variants is v${cta?.version}, expected v2`);
  if (policy) throw new Error(`evidence_policy already exists (v${policy.version})`);

  const v9 = buildWriterPromptV9(String(writer.value));
  const ctaV3 = buildCtaVariantsV3(cta.value as { variants: { id: string; active: boolean; text: string }[] });
  const evidencePolicy = { max_age_days: 30 };

  console.log("=== writer_prompt_email v8 → v9 (changed sections) ===");
  const before = String(writer.value).split("\n");
  const after = v9.split("\n");
  for (const line of after) if (!before.includes(line)) console.log(`+ ${line}`);
  for (const line of before) if (!after.includes(line)) console.log(`- ${line}`);
  console.log("\n=== cta_variants v2 → v3 ===");
  console.log(JSON.stringify(ctaV3, null, 2));
  console.log("\n=== evidence_policy v1 ===");
  console.log(JSON.stringify(evidencePolicy));

  if (!apply) {
    console.log("\n(dry-run) Add --apply to write writer_prompt_email v9, cta_variants v3, evidence_policy v1.");
    return;
  }

  const p = await settings.writeNewVersion("evidence_policy", evidencePolicy, CHANGED_BY, "U6b claim guard: cited evidence older than 30 days refuses a draft (stale_evidence)");
  const c = await settings.writeNewVersion("cta_variants", ctaV3, CHANGED_BY, `U6b: the only approved offer line (operator, Session 15): "${APPROVED_OFFER_LINE}"`);
  const w = await settings.writeNewVersion("writer_prompt_email", v9, CHANGED_BY, "U6b: claim ledger output, evidence ids, no timings, no asset claims, approved offer line verbatim");
  console.log(`\nWROTE evidence_policy v${p.version} · cta_variants v${c.version} · writer_prompt_email v${w.version}`);
}

main().catch((error: unknown) => {
  console.error("update-writer-prompt-v9-claims FAILED:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
