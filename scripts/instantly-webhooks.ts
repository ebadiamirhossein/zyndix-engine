import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createInstantlyClient, InstantlyError } from "../src/lib/integrations/instantly";
import { WEBHOOK_TOKEN_HEADER } from "../src/lib/webhooks/instantly";

// Instantly webhook management (09 §U6). The only writes are explicit flags,
// each run only with operator approval:
//
//   pnpm tsx scripts/instantly-webhooks.ts --list                     read-only
//   pnpm tsx scripts/instantly-webhooks.ts --create --url https://…   WRITE: one webhook, all_events,
//                                                                      target must end /api/webhooks/instantly
//   pnpm tsx scripts/instantly-webhooks.ts --test <id>                WRITE-ish: Instantly POSTs a test payload
//   pnpm tsx scripts/instantly-webhooks.ts --delete <id>              WRITE: removes the webhook
//
// The auth header value (INSTANTLY_WEBHOOK_SECRET) is sent to Instantly and
// never printed; the adapter strips it from every response and error.

const args = process.argv.slice(2);
const value = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

async function main(): Promise<void> {
  const instantly = createInstantlyClient();

  if (args.includes("--create")) {
    const target = value("--url");
    if (!target || !/^https:\/\/[^/]+\/api\/webhooks\/instantly$/.test(target)) {
      throw new Error("--create needs --url https://<host>/api/webhooks/instantly");
    }
    const secret = process.env.INSTANTLY_WEBHOOK_SECRET;
    if (!secret || secret.length < 32) throw new Error("INSTANTLY_WEBHOOK_SECRET missing or shorter than 32 chars in .env.local");
    const existing = await instantly.listWebhooks({ limit: 100 });
    const same = existing.items.filter((w) => w.target_hook_url === target);
    if (same.length) throw new Error(`a webhook for this URL already exists (${same.map((w) => w.id).join(", ")}) — nothing created`);
    const hook = await instantly.createWebhook({
      targetUrl: target,
      eventType: "all_events",
      name: "zyndix-engine",
      authHeader: { name: WEBHOOK_TOKEN_HEADER, value: secret },
    });
    console.log(`CREATED webhook ${hook.id} event_type=${hook.event_type} status=${hook.status ?? "?"} headers=[${hook.header_names.join(",")}]`);
    return;
  }

  const testId = value("--test");
  if (testId) {
    const result = await instantly.testWebhook(testId);
    console.log(`TEST ${testId}: success=${result.success} status_code=${result.status_code ?? "?"} response_time_ms=${result.response_time_ms ?? "?"} ${result.error ?? result.message ?? ""}`);
    return;
  }

  const deleteId = value("--delete");
  if (deleteId) {
    await instantly.deleteWebhook(deleteId);
    console.log(`DELETED webhook ${deleteId}`);
    return;
  }

  const page = await instantly.listWebhooks({ limit: 100 });
  console.log(`webhooks: ${page.items.length}`);
  for (const w of page.items) {
    console.log(`  ${w.id} ${w.event_type ?? "custom"} status=${w.status ?? "?"} → ${w.target_hook_url} headers=[${w.header_names.join(",")}]`);
  }
}

main().catch((error: unknown) => {
  const kind = error instanceof InstantlyError ? ` (${error.name}${"kind" in error ? `:${String((error as { kind?: string }).kind)}` : ""})` : "";
  console.error(`instantly-webhooks FAILED${kind}:`, error instanceof Error ? error.message : String(error));
  process.exit(1);
});
