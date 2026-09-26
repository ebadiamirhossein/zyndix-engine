import { handleCalendlyWebhook } from "@/lib/webhooks/calendly";
import { createCalendlyWebhookDeps } from "@/lib/webhooks/calendly-server";

// Calendly webhook deliveries (09 §U8). Signature check, persist-first,
// dedupe and processing all live in lib/webhooks/calendly.ts; this file only
// wires deps.
export async function POST(req: Request): Promise<Response> {
  return handleCalendlyWebhook(req, createCalendlyWebhookDeps());
}
