import { capacityDefaultsSchema } from "@/lib/validation/jsonb";
import { WebhookProcessingError } from "@/lib/webhooks/exceptions";

import { pauseSender, type StopDeps } from "./stop";

// bounce_rate_7d (09 §U6, §U9). Recomputed on every bounce webhook and by the
// daily cron. Moved out of webhooks/instantly.ts in Wave 1 so /api/cron/daily
// can call it without the webhook deps.

const DAY_MS = 86_400_000;

export type BounceRateDeps = StopDeps & {
  getActiveSetting: (key: string) => Promise<{ value: unknown }>;
};

export type BounceRateResult = { total: number; rate: number | null; paused: boolean };

/** bounce_rate_7d = bounced / sent over the last 7 days; above the auto_pause threshold → paused. */
export async function checkBounceRate(
  deps: BounceRateDeps,
  eventId: string | null,
  accountId: string,
  now: Date,
): Promise<BounceRateResult> {
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const { data: sent, error } = await deps.db
    .from("touches")
    .select("status")
    .eq("send_account_id", accountId)
    .eq("direction", "outbound")
    .gte("sent_at", since);
  if (error) throw new WebhookProcessingError(`bounce rate: ${error.message}`);
  const total = (sent ?? []).length;
  // Unknown is null, never zero: no sends in 7 days leaves the stored rate as it is.
  if (total === 0) return { total, rate: null, paused: false };
  const rate = (sent ?? []).filter((t) => t.status === "bounced").length / total;

  const defaults = capacityDefaultsSchema.parse((await deps.getActiveSetting("capacity_defaults")).value);
  const threshold = defaults.auto_pause.bounce_rate_7d;
  const paused = rate > threshold;
  const { data: account, error: accountError } = await deps.db
    .from("send_accounts")
    .update({
      bounce_rate_7d: rate,
      ...(paused ? { health: "paused", paused_reason: `bounce_rate_7d ${rate.toFixed(3)} > ${threshold}` } : {}),
    })
    .eq("id", accountId)
    .select("identifier, instantly_campaign_id")
    .single();
  if (accountError) throw new WebhookProcessingError(`bounce rate update: ${accountError.message}`);
  if (!paused) return { total, rate, paused };

  await pauseSender(deps, {
    account: { id: accountId, identifier: account?.identifier ?? null, instantly_campaign_id: account?.instantly_campaign_id ?? null },
    reason: null, // health/paused_reason already written above, together with bounce_rate_7d
    eventId,
    why: `bounce_rate_7d ${(rate * 100).toFixed(1)}% > ${(threshold * 100).toFixed(1)}% (${total} sent in 7d)`,
  });
  return { total, rate, paused };
}
