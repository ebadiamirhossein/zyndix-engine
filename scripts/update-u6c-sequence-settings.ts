/**
 * scripts/update-u6c-sequence-settings.ts — 09 §U6c (Session 19).
 *
 * Writes three versioned settings, all or nothing per run:
 *   - email_sequence v1: 3 steps, delays 0/7/7 days after the previous step
 *     (days 0/7/14); steps 1–2 from the writer, step 3 from a template.
 *   - followup_templates v1: step 3, the operator's "honest close", exact.
 *   - writer_prompt_email v10: v9 + a two-step sequence output
 *     {steps:[{step_no, subject?, body, claims}]}; only step 1 has a subject;
 *     step 2 is a new angle that cites evidence. All v9 rules stay.
 *
 * Default is a dry run that prints the new values. `--apply` writes them.
 * Guards: refuses unless writer_prompt_email is v9 and neither new key exists,
 * so it cannot clobber a newer edit. Every value is validated by the same
 * schema the settings store applies on read.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";
import { emailSequenceSchema, followupTemplatesSchema } from "../src/lib/validation/jsonb";

const CHANGED_BY = "session-19-u6c";

export const EMAIL_SEQUENCE_V1 = {
  steps: [
    { step_no: 1, delay: 0, delay_unit: "days", source: "writer" },
    { step_no: 2, delay: 7, delay_unit: "days", source: "writer" },
    { step_no: 3, delay: 7, delay_unit: "days", source: "template" },
  ],
} as const;

/** Operator-written (Session 19), exact. */
export const HONEST_CLOSE =
  "Hi {first_name},\n\nI haven't heard back, so I'll assume now isn't the right time and won't follow up again.\n\nIf it becomes a priority later, just reply to this email.";

export const FOLLOWUP_TEMPLATES_V1 = {
  templates: [{ step_no: 3, id: "honest_close", body: HONEST_CLOSE }],
};

const SEQUENCE_BLOCK = `SEQUENCE (you write steps 1 and 2 of a 3-step email sequence; step 3 is a fixed template)
- The input's "sequence" lists the steps you write and the day each goes out (step 1 = day 0).
- Step 1: the first email, exactly as described above, with a subject.
- Step 2: a follow-up one week later, sent in the SAME thread as step 1. It has NO subject
  (the thread keeps step 1's). The recipient sees a quote of step 1 under it, so never repeat
  step 1's phrasing or its observation.
  Take a NEW angle: a different observation or consequence, grounded in the evidence and cited
  like any claim (ideally a different evidence item than step 1's opener).
  ≤70 words. Never "just following up", "bumping this", "circling back", or any reference to
  your previous email.
  Any offer in step 2 is the approved line only, verbatim, as its own line — or no offer at all.
- Both steps follow every rule above and below: no timings, no prepared-asset claims, no
  invented numbers, no sign-off, no footer.
- Each step has its own claims list. A span must be copied from THAT step's subject or body.`;

function replaceOnce(text: string, from: string | RegExp, to: string, label: string): string {
  const found = typeof from === "string" ? text.includes(from) : from.test(text);
  if (!found) throw new Error(`v9 anchor not found: ${label}`);
  return text.replace(from, to);
}

export function buildWriterPromptV10(v9: string): string {
  let p = v9;
  p = replaceOnce(
    p,
    /proof_point \(may be null\), sequence step hint \(e\.g\. "first touch" or\n"attach_pdf"\)\./,
    "proof_point (may be null), and sequence (the steps you write, with the day each goes out).",
    "INPUT",
  );
  p = replaceOnce(p, "Write ONE email. Rules:", "Write steps 1 and 2 of the sequence (see SEQUENCE). Rules:", "Write ONE email");
  p = replaceOnce(
    p,
    /STEP VARIANTS\n- first touch: as above\.\n- step 2 \(\+3d\):[^\n]*\n- step 3 \(\+7d, attach_pdf\):[^\n]*\n[^\n]*\n- step 4 \(\+14d\):[^\n]*\n[^\n]*\n/,
    `${SEQUENCE_BLOCK}\n`,
    "STEP VARIANTS",
  );
  p = replaceOnce(
    p,
    'OUTPUT STRICT JSON: Return ONLY {"subject": "...", "body": "...", "claims": [...]}. No other keys.',
    'OUTPUT STRICT JSON: Return ONLY {"steps": [{"step_no": 1, "subject": "...", "body": "...", "claims": [...]}, {"step_no": 2, "body": "...", "claims": [...]}]}. Step 2 has no "subject" key. No other keys.',
    "OUTPUT",
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

  async function active(keyName: string): Promise<{ version: number; value: unknown } | null> {
    const { data, error } = await db.from("settings").select("version, value").eq("key", keyName).eq("active", true).maybeSingle();
    if (error) throw new Error(`read ${keyName}: ${error.message}`);
    return data;
  }

  const apply = process.argv.includes("--apply");
  const [writer, sequence, templates] = await Promise.all([
    active("writer_prompt_email"),
    active("email_sequence"),
    active("followup_templates"),
  ]);

  if (writer?.version !== 9) throw new Error(`writer_prompt_email is v${writer?.version}, expected v9`);
  if (sequence) throw new Error(`email_sequence already exists (v${sequence.version})`);
  if (templates) throw new Error(`followup_templates already exists (v${templates.version})`);

  const v10 = buildWriterPromptV10(String(writer.value));
  const seq = emailSequenceSchema.parse(EMAIL_SEQUENCE_V1);
  const tpl = followupTemplatesSchema.parse(FOLLOWUP_TEMPLATES_V1);

  console.log("=== writer_prompt_email v9 → v10 (changed lines) ===");
  const before = String(writer.value).split("\n");
  const after = v10.split("\n");
  for (const line of after) if (!before.includes(line)) console.log(`+ ${line}`);
  for (const line of before) if (!after.includes(line)) console.log(`- ${line}`);
  console.log("\n=== email_sequence v1 ===");
  console.log(JSON.stringify(seq, null, 2));
  console.log("\n=== followup_templates v1 ===");
  console.log(JSON.stringify(tpl, null, 2));

  if (!apply) {
    console.log("\n(dry-run) Add --apply to write email_sequence v1, followup_templates v1, writer_prompt_email v10.");
    return;
  }

  const s = await settings.writeNewVersion(
    "email_sequence",
    seq,
    CHANGED_BY,
    "U6c: 3 steps, delays 0/7/7 days after the previous step (days 0/7/14); steps 1–2 writer, step 3 template",
  );
  const t = await settings.writeNewVersion("followup_templates", tpl, CHANGED_BY, "U6c: step 3 honest close (operator-written, exact)");
  const w = await settings.writeNewVersion(
    "writer_prompt_email",
    v10,
    CHANGED_BY,
    "U6c: writes steps 1–2 as {steps:[…]}; only step 1 has a subject; step 2 is a new angle citing evidence; v9 rules kept",
  );
  console.log(`\nWROTE email_sequence v${s.version} · followup_templates v${t.version} · writer_prompt_email v${w.version}`);
}

if (process.argv[1]?.endsWith("update-u6c-sequence-settings.ts")) {
  main().catch((error: unknown) => {
    console.error("update-u6c-sequence-settings FAILED:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
