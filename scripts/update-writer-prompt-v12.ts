/**
 * scripts/update-writer-prompt-v12.ts — 09 §UR (Wave 1) + the 09 §5 backlog
 * row "UR prompt work: the writer reserves ≥ 1 evidence item for step 2".
 *
 * writer_prompt_email v11 → v12:
 *   - step 1 must leave at least one evidence item unused, so step 2 has its
 *     own (07 Session 20 addendum: with 2 items, v11's step 1 cited both and
 *     left step 2 nothing new — step2_repeats_step1 / the guard were the only
 *     barrier);
 *   - research evidence (09 §UR) may carry a url, a published date and a fetch
 *     date, and its observation is a verbatim excerpt: never say how it was
 *     gathered, never name a reviewer (or anyone but the lead), never quote a
 *     review or post beyond its excerpt, never present an old dated item as
 *     current.
 *
 * Default is a dry run that prints the changed lines (a read of the active
 * prompt from Supabase). `--apply` writes v12 — only after the operator's OK.
 * Guard: refuses unless the active version is v11, so it cannot clobber a
 * newer edit.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";

const CHANGED_BY = "wave-1-ur";

const INPUT_ADDITION = `
Some evidence items come from public sources (a LinkedIn post or profile, a job post, a Google
review, a news article, their blog). Those items also carry "url", "source_type", "fetched_at"
(when it was read) and, when the source has one, "published_at"; their "observation" is a verbatim
excerpt of that source.`;

const DATED_SOURCES_BLOCK = `DATED SOURCES (evidence items with a url)
- Never say how anything was found or that you researched them: no tools, scraping, monitoring,
  alerts, "I came across", "I was looking into you". You may name the kind of source ("your job
  post", "your recent post", "a recent review"), but never the platform: no "LinkedIn", no "Google"
  (the excerpt does not contain the platform name, so the checker refuses it).
- Quote only words that appear verbatim in that item's observation, and never more than a short
  phrase. Never quote or paraphrase a review or post beyond its excerpt.
- Never name, describe or quote a reviewer or any person other than the lead. A review is one
  customer's account: say "a recent review mentions …", never state it as a fact about how they
  work, and never mention a star rating.
- Dates: never write a date, month or year. If an item's published_at is more than 90 days before
  its fetched_at, write about it in the past tense ("you posted about …", "you were hiring for …"),
  never as happening now. An item with no published_at has no known date: never say when it
  happened or imply it is recent.
- A news item is about them only as far as its excerpt says; never add what the article might say.`;

function replaceOnce(text: string, from: string, to: string, label: string): string {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`v11 anchor "${label}" found ${count} times, expected 1`);
  return text.replace(from, to);
}

export function buildWriterPromptV12(v11: string): string {
  let p = v11;
  p = replaceOnce(
    p,
    "proof_point (may be null), and sequence (the steps you write, with the day each goes out).",
    `proof_point (may be null), and sequence (the steps you write, with the day each goes out).${INPUT_ADDITION}`,
    "INPUT",
  );
  p = replaceOnce(p, "\nFORBIDDEN\n", `\n${DATED_SOURCES_BLOCK}\n\nFORBIDDEN\n`, "FORBIDDEN");
  p = replaceOnce(
    p,
    "- Step 1: the first email, exactly as described above, with a subject.",
    `- Step 1: the first email, exactly as described above, with a subject. Plan both steps first:
  choose the evidence item(s) step 2 will cite, and do NOT cite them in step 1. Step 1 MUST leave
  at least one evidence item unused, so step 2 has its own.`,
    "step 1",
  );
  return p;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const db = createServiceClient(url, key);
  const settings = createSettingsStore(db);
  const apply = process.argv.includes("--apply");

  const { data: writer, error } = await db
    .from("settings")
    .select("version, value")
    .eq("key", "writer_prompt_email")
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(`read writer_prompt_email: ${error.message}`);
  if (writer?.version !== 11) throw new Error(`writer_prompt_email is v${writer?.version}, expected v11`);

  const v11 = String(writer.value);
  const v12 = buildWriterPromptV12(v11);

  console.log("=== writer_prompt_email v11 → v12 (changed lines) ===");
  const before = v11.split("\n");
  const after = v12.split("\n");
  for (const line of before) if (!after.includes(line)) console.log(`- ${line}`);
  for (const line of after) if (!before.includes(line)) console.log(`+ ${line}`);
  console.log(`\nlength ${v11.length} → ${v12.length} chars`);

  if (!apply) {
    console.log("\n(dry-run) Add --apply to write writer_prompt_email v12.");
    return;
  }
  const w = await settings.writeNewVersion(
    "writer_prompt_email",
    v12,
    CHANGED_BY,
    "UR: step 1 leaves ≥1 evidence item for step 2; dated research sources (url/published/fetched): never say how gathered, never name reviewers, quote only the excerpt, never present an old item as current",
  );
  console.log(`\nWROTE writer_prompt_email v${w.version}`);
}

if (process.argv[1]?.endsWith("update-writer-prompt-v12.ts")) {
  main().catch((error: unknown) => {
    console.error("update-writer-prompt-v12 FAILED:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
