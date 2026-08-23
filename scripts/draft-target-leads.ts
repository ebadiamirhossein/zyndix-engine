import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { createServiceClient } from "../src/lib/db/service-client";
import { createAnthropicClient } from "../src/lib/integrations/anthropic";
import { createTelegramClient } from "../src/lib/integrations/telegram";
import { createSettingsStore } from "../src/lib/settings/core";
import { createStateStore } from "../src/lib/state/core";
import { runDraftStage } from "../src/lib/stages/draft/core";
import { wordCount } from "../src/lib/stages/draft/guard";
import { formatApprovalMessagePlain } from "../src/lib/integrations/telegram-approval";

const TARGET_DOMAINS = [
  "gottesmanresidential.com",
  "rebgrouponline.com",
  "steffengrp.com",
  "striderealestate.com",
];

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) process.exit(1);

const db = createServiceClient(url, key);
const state = createStateStore(db);
const settings = createSettingsStore(db);
const anthropic = createAnthropicClient();
const telegram = createTelegramClient();

async function main(): Promise<void> {
  const footer = String((await settings.getActiveSetting("compliance_footer")).value);

  const { data: targets } = await db
    .from("leads")
    .select("id, first_name, last_name, state, companies!inner(domain, name)")
    .in("companies.domain", TARGET_DOMAINS);

  const targetIds = (targets ?? []).map((row) => row.id);

  const { data: drafting } = await db
    .from("leads")
    .select("id, companies(domain)")
    .eq("state", "drafting");

  for (const row of drafting ?? []) {
    const domain = (row.companies as { domain: string | null } | null)?.domain;
    if (!targetIds.includes(row.id)) {
      await db.from("leads").update({ state: "parked" }).eq("id", row.id);
    }
  }

  for (const row of targets ?? []) {
    await db.from("touches").delete().eq("lead_id", row.id);
    await db.from("leads").update({ state: "drafting" }).eq("id", row.id);
  }

  const summary = await runDraftStage(
    {
      db,
      anthropic,
      telegram,
      getActiveSetting: settings.getActiveSetting,
      transition: state.transition,
    },
    { limit: 4 },
  );

  console.log(JSON.stringify(summary, null, 2));

  const { data: touches } = await db
    .from("touches")
    .select(
      `lead_id, subject, draft_body,
      leads(
        first_name, last_name, title, email_status,
        companies(name, domain),
        qualification(fit_score, segment, problem_hypothesis, evidence, recommended_angle)
      )`,
    )
    .in("lead_id", targetIds)
    .order("created_at", { ascending: false });

  console.log("\n=== TARGET DRAFTS ===\n");
  for (const touch of touches ?? []) {
    const lead = touch.leads as {
      first_name: string | null;
      last_name: string | null;
      title: string | null;
      email_status: string | null;
      companies: { name: string; domain: string | null } | null;
      qualification: {
        fit_score: number | null;
        segment: string | null;
        problem_hypothesis: string;
        evidence: unknown;
        recommended_angle: string | null;
      } | {
        fit_score: number | null;
        segment: string | null;
        problem_hypothesis: string;
        evidence: unknown;
        recommended_angle: string | null;
      }[] | null;
    } | null;
    const qualRaw = lead?.qualification;
    const qual = (Array.isArray(qualRaw) ? qualRaw[0] : qualRaw) as {
      fit_score: number | null;
      segment: string | null;
      problem_hypothesis: string;
      evidence: unknown;
      recommended_angle: string | null;
    } | null;
    const body = touch.draft_body ?? "";
    const modelBody = body.includes(footer.trim())
      ? body.replace(`\n\n${footer.trim()}`, "").trim()
      : body.split("\n\n— Amir")[0]?.trim() ?? body;
    console.log(`--- ${lead?.first_name ?? ""} ${lead?.last_name ?? ""} / ${lead?.companies?.name ?? ""} ---`);
    console.log(`SUBJECT: ${touch.subject}`);
    console.log(`BODY (${wordCount(modelBody)} words):\n${modelBody}\n`);
    if (body !== modelBody) {
      console.log(`SIGNATURE:\n${footer}\n`);
    }

    if (lead && qual) {
      const evidence = Array.isArray(qual.evidence)
        ? qual.evidence
            .filter(
              (item): item is { observation: string } =>
                typeof item === "object" &&
                item !== null &&
                "observation" in item &&
                typeof (item as { observation: unknown }).observation === "string",
            )
            .map((item) => ({ observation: item.observation }))
        : [];
      console.log("--- Telegram card ---");
      console.log(
        formatApprovalMessagePlain(
          {
            id: touch.lead_id ?? "",
            subject: touch.subject,
            draft_body: touch.draft_body,
            body: null,
            status: "pending_approval",
          },
          {
            id: touch.lead_id ?? "",
            first_name: lead.first_name,
            last_name: lead.last_name,
            title: lead.title,
            email_status: lead.email_status,
          },
          {
            fit_score: qual.fit_score,
            segment: qual.segment,
            problem_hypothesis: qual.problem_hypothesis,
            evidence,
            recommended_angle: qual.recommended_angle,
          },
          {
            name: lead.companies?.name ?? "",
            domain: lead.companies?.domain ?? null,
          },
        ),
      );
      console.log("");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
