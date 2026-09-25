import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import {
  accountHealth,
  createInstantlyReadClient,
  InstantlyError,
  InstantlyPermanentError,
  type InstantlyReadClient,
} from "../src/lib/integrations/instantly";
import {
  ACCOUNT_PROVIDER_LABELS,
  ACCOUNT_STATUS_LABELS,
  ACCOUNT_WARMUP_STATUS_LABELS,
  CAMPAIGN_STATUS_LABELS,
  label,
  type InstantlyAccount,
} from "../src/lib/integrations/instantly-types";

// Live, READ-ONLY check of the Instantly adapter (09 §U4, "verified with
// provider" for read paths). It is handed createInstantlyReadClient(), which
// has no mutating operations, so this script cannot change anything in
// Instantly. Every response is parsed by the same Zod schemas the contract
// suite's fixtures use.
//
//   pnpm tsx scripts/live-instantly.ts --whoami     workspace + account count (09 DoD)
//   pnpm tsx scripts/live-instantly.ts --accounts   per-mailbox status / warmup / health
//   pnpm tsx scripts/live-instantly.ts --campaigns  campaign count and list
//   pnpm tsx scripts/live-instantly.ts --warmup     warmup-analytics health score per mailbox
//   pnpm tsx scripts/live-instantly.ts --webhooks-probe  can this plan reach webhooks?
//   pnpm tsx scripts/live-instantly.ts --all

const output: string[] = [];
function out(line = ""): void {
  output.push(line);
  console.log(line);
}

const args = new Set(process.argv.slice(2));
const all = args.has("--all");
const want = (flag: string) => all || args.has(flag);
if (![...args].some((a) => ["--all", "--whoami", "--accounts", "--campaigns", "--warmup", "--webhooks-probe"].includes(a))) {
  console.error("usage: live-instantly.ts --whoami | --accounts | --campaigns | --warmup | --webhooks-probe | --all");
  process.exit(2);
}

const key = process.env.INSTANTLY_API_KEY;
let failures = 0;

function describe(error: unknown): string {
  if (error instanceof InstantlyPermanentError) return `${error.name}[${error.kind}] ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    failures += 1;
    out(`FAIL: ${name} — ${describe(error)}`);
    return null;
  }
}

async function main(): Promise<void> {
  out("=== live-instantly (read-only) ===");
  out(`INSTANTLY_API_KEY: ${key ? "configured" : "missing"}`);
  if (!key) {
    failures += 1;
    return;
  }

  const client: InstantlyReadClient = createInstantlyReadClient();
  let accounts: InstantlyAccount[] | null = null;
  const loadAccounts = async () => {
    if (accounts) return accounts;
    const result = await step("listAllAccounts", () => client.listAllAccounts());
    if (result?.truncated) out("WARN: account listing hit the page cap");
    accounts = result?.items ?? null;
    return accounts;
  };

  if (want("--whoami")) {
    out("\n--- whoami ---");
    const workspace = await step("getCurrentWorkspace", () => client.getCurrentWorkspace());
    if (workspace) {
      out(`workspace: ${workspace.name}`);
      out(`plan_id: ${workspace.plan_id ?? "—"}`);
    }
    const list = await loadAccounts();
    if (list) out(`accounts: ${list.length}`);
  }

  if (want("--accounts")) {
    out("\n--- accounts ---");
    const list = await loadAccounts();
    for (const account of list ?? []) {
      const health = accountHealth(account);
      out(
        [
          account.email,
          `provider=${label(ACCOUNT_PROVIDER_LABELS, account.provider_code)}`,
          `status=${label(ACCOUNT_STATUS_LABELS, account.status)}`,
          `warmup=${label(ACCOUNT_WARMUP_STATUS_LABELS, account.warmup_status)}`,
          `daily_limit=${account.daily_limit ?? "—"}`,
          `warmup_score=${account.stat_warmup_score ?? "—"}`,
          `setup_pending=${account.setup_pending}`,
          `warmup_start=${account.timestamp_warmup_start ?? "—"}`,
          `health=${health.verdict}${health.reasons.length ? ` (${health.reasons.join(",")})` : ""}`,
        ].join("  "),
      );
    }
  }

  if (want("--campaigns")) {
    out("\n--- campaigns ---");
    const result = await step("listAllCampaigns", () => client.listAllCampaigns());
    if (result) {
      out(`campaigns: ${result.items.length}${result.truncated ? " (truncated)" : ""}`);
      for (const campaign of result.items) {
        out(`  ${campaign.id}  ${campaign.name}  status=${label(CAMPAIGN_STATUS_LABELS, campaign.status)}`);
      }
    }
  }

  if (want("--warmup")) {
    out("\n--- warmup analytics ---");
    const list = await loadAccounts();
    if (list && list.length > 0) {
      const analytics = await step("getWarmupAnalytics", () =>
        client.getWarmupAnalytics(list.map((a) => a.email)),
      );
      for (const account of list) {
        const agg = analytics?.aggregate_data[account.email];
        out(
          agg
            ? `${account.email}  sent=${agg.sent ?? "—"} received=${agg.received ?? "—"} inbox=${agg.landed_inbox ?? "—"} spam=${agg.landed_spam ?? "—"} health_score=${agg.health_score ?? "—"} (${agg.health_score_label ?? "—"})`
            : `${account.email}  no warmup data yet`,
        );
      }
    } else {
      out("no accounts to query");
    }
  }

  if (want("--webhooks-probe")) {
    out("\n--- webhooks probe (plan tier) ---");
    try {
      const types = await client.listWebhookEventTypes();
      out(`webhook event types reachable: ${types.event_types.length} types`);
      const ids = types.event_types
        .map((t) => (typeof t.id === "string" ? t.id : typeof t.type === "string" ? t.type : null))
        .filter((v): v is string => v !== null);
      if (ids.length) out(`  ${ids.join(", ")}`);
    } catch (error) {
      if (error instanceof InstantlyPermanentError && (error.kind === "plan" || error.kind === "scope")) {
        out(`webhooks NOT reachable on this key/plan: ${describe(error)}`);
      } else {
        failures += 1;
        out(`FAIL: listWebhookEventTypes — ${describe(error)}`);
      }
    }
  }
}

main()
  .catch((error) => {
    failures += 1;
    out(`FAIL: unexpected — ${error instanceof InstantlyError ? describe(error) : String(error)}`);
  })
  .finally(() => {
    // Secret self-check over everything this script printed.
    let leaked = false;
    if (key) {
      const text = output.join("\n");
      const window = Math.min(12, key.length);
      for (let i = 0; i + window <= key.length && !leaked; i++) {
        if (text.includes(key.slice(i, i + window))) leaked = true;
      }
    }
    console.log(`\nsecret material in output: ${leaked ? "FOUND — do not share this output" : "none"}`);
    console.log(failures === 0 && !leaked ? "RESULT: pass" : `RESULT: fail (${failures} failure(s))`);
    process.exit(failures === 0 && !leaked ? 0 : 1);
  });
