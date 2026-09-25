import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createSettingsStore } from "../src/lib/settings/core";
import { compliance_footer, send_policy } from "../src/lib/settings/seed-content";

// Session 12 operator decisions, as new versioned settings rows. DRY RUN BY DEFAULT.
//   compliance_footer  → drop the "— Amir" sign-off; the mailbox signature replaces it
//   writer_prompt_email → built from the ACTIVE version: one COMPLIANCE line forbidding a sign-off
//   send_policy        → assignable_senders = the two amir@ mailboxes (writer persona is Amir)
//
//   pnpm tsx scripts/update-signature-settings.ts           dry run
//   pnpm tsx scripts/update-signature-settings.ts --apply   writes — operator approval first

const apply = process.argv.includes("--apply");
const CHANGED_BY = "session-12";

const COMPLIANCE_ANCHOR = "- Do NOT include a physical address or opt-out line in the body.";
const NO_SIGN_OFF = `- Do NOT sign off and do NOT write your name at the end (no "— Amir", no
  "Best, Amir"). The system appends the sending mailbox's signature.
`;

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  const settings = createSettingsStore(createServiceClient(url, key));
  console.log(`=== update-signature-settings (${apply ? "APPLY" : "dry run"}) ===`);

  const footer = await settings.getActiveSetting("compliance_footer");
  const writer = await settings.getActiveSetting("writer_prompt_email");
  const policy = await settings.getActiveSetting("send_policy");

  const plan: Array<{ key: string; value: unknown; note: string }> = [];

  if (String(footer.value) !== compliance_footer) {
    console.log(`\ncompliance_footer v${footer.version} → v${footer.version + 1}`);
    console.log(`  - ${JSON.stringify(footer.value)}\n  + ${JSON.stringify(compliance_footer)}`);
    plan.push({ key: "compliance_footer", value: compliance_footer, note: "Session 12: sign-off removed; the sending mailbox's signature goes right before this footer" });
  } else console.log(`\nSKIP compliance_footer (v${footer.version} already current)`);

  const prompt = String(writer.value);
  if (prompt.includes("Do NOT sign off")) {
    console.log(`SKIP writer_prompt_email (v${writer.version} already forbids a sign-off)`);
  } else {
    if (!prompt.includes(COMPLIANCE_ANCHOR)) throw new Error(`writer_prompt_email v${writer.version}: COMPLIANCE anchor not found — nothing written`);
    const next = prompt.replace(COMPLIANCE_ANCHOR, `${NO_SIGN_OFF.trimEnd()}\n${COMPLIANCE_ANCHOR}`);
    console.log(`\nwriter_prompt_email v${writer.version} → v${writer.version + 1} (only change: under COMPLIANCE, inserted)`);
    console.log(NO_SIGN_OFF.trimEnd().split("\n").map((l) => `  + ${l}`).join("\n"));
    plan.push({ key: "writer_prompt_email", value: next, note: "Session 12: no sign-off in the body; mailbox signature appended at send" });
  }

  const currentPolicy = policy.value as Record<string, unknown>;
  if (JSON.stringify(currentPolicy.assignable_senders ?? null) !== JSON.stringify(send_policy.assignable_senders)) {
    const nextPolicy = { ...currentPolicy, assignable_senders: [...send_policy.assignable_senders] };
    console.log(`\nsend_policy v${policy.version} → v${policy.version + 1}: + assignable_senders ${JSON.stringify(nextPolicy.assignable_senders)}`);
    plan.push({ key: "send_policy", value: nextPolicy, note: "Session 12: writer persona is Amir — approval assigns only amir@ mailboxes" });
  } else console.log(`SKIP send_policy (v${policy.version} already current)`);

  if (!apply) {
    console.log(`\nDry run: ${plan.length} new version(s) would be written. Re-run with --apply after operator approval.`);
    return;
  }
  for (const row of plan) {
    const written = await settings.writeNewVersion(row.key, row.value, CHANGED_BY, row.note);
    console.log(`WROTE  ${row.key} v${written.version}`);
  }
}

main().catch((error: unknown) => {
  console.error("update-signature-settings FAILED:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
