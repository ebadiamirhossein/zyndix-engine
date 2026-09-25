import { handleInstantlyWebhook } from "@/lib/webhooks/instantly";
import { createInstantlyWebhookDeps } from "@/lib/webhooks/instantly-server";

// Instantly webhook deliveries (09 §U6). Auth, persist-first, dedupe and
// processing all live in lib/webhooks/instantly.ts; this file only wires deps.
export async function POST(req: Request): Promise<Response> {
  return handleInstantlyWebhook(req, createInstantlyWebhookDeps());
}
