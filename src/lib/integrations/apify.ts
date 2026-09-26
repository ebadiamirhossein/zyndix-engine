import { z } from "zod";

import { parseOrThrow } from "@/lib/validation";
import { apifyRunResultSchema } from "@/lib/validation/external";

const APIFY_BASE_URL = "https://api.apify.com/v2";

const TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "TIMED-OUT",
  "ABORTED",
]);

const apifyDatasetItemsSchema = z.array(z.record(z.string(), z.unknown()));

type ApifyRun = z.infer<typeof apifyRunResultSchema>;

export class ApifyTimeoutError extends Error {
  readonly runId: string;

  constructor(runId: string, timeoutMs: number) {
    super(`Apify run ${runId} did not finish within ${timeoutMs}ms`);
    this.name = "ApifyTimeoutError";
    this.runId = runId;
  }
}

export class ApifyApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Apify API error (${status}): ${body}`);
    this.name = "ApifyApiError";
    this.status = status;
    this.body = body;
  }
}

export type ApifyRunWithItems = {
  runId: string;
  actorId: string;
  status: string;
  datasetId: string | null;
  durationMs: number;
  itemCount: number;
  items: Record<string, unknown>[];
};

export type ApifyClient = ReturnType<typeof createApifyClient>;

/**
 * Run options passed as query parameters of `POST /v2/acts/{actorId}/runs`
 * (https://docs.apify.com/api/v2/act-runs-post, read 2026-09-26):
 *   - maxItems: "Specifies the maximum number of dataset items that will be
 *     charged for pay-per-result Actors."
 *   - maxTotalChargeUsd: "Specifies the maximum total cost of the run. Use it
 *     to cap the total amount charged for all pricing models."
 * 09 §UR: every research run passes both (the provider-side hard cap).
 */
export type ApifyRunOptions = {
  maxItems?: number;
  maxTotalChargeUsd?: number;
};

/** Query string for the run options; "" when none are set. Exported for tests. */
export function runOptionsQuery(options?: ApifyRunOptions): string {
  const params = new URLSearchParams();
  if (options?.maxItems !== undefined) {
    if (!Number.isInteger(options.maxItems) || options.maxItems < 1) {
      throw new Error(`apify: maxItems must be a positive integer, got ${options.maxItems}`);
    }
    params.set("maxItems", String(options.maxItems));
  }
  if (options?.maxTotalChargeUsd !== undefined) {
    if (!Number.isFinite(options.maxTotalChargeUsd) || options.maxTotalChargeUsd <= 0) {
      throw new Error(`apify: maxTotalChargeUsd must be > 0, got ${options.maxTotalChargeUsd}`);
    }
    params.set("maxTotalChargeUsd", String(options.maxTotalChargeUsd));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function requireToken(): string {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error("Missing APIFY_TOKEN");
  }
  return token;
}

function pollTimeoutMs(): number {
  const raw = process.env.APIFY_POLL_TIMEOUT_MS ?? "300000";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
}

function encodeActorId(actorId: string): string {
  return actorId.includes("/") ? actorId.replace("/", "~") : actorId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apifyFetch(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<unknown> {
  const token = requireToken();
  const separator = path.includes("?") ? "&" : "?";
  const url = `${APIFY_BASE_URL}${path}${separator}token=${token}`;

  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await sleep(500 * attempt);
    }

    try {
      const response = await fetch(url, {
        method: options?.method ?? "GET",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });

      const text = await response.text();
      let json: unknown = {};
      if (text) {
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = { raw: text };
        }
      }

      if (!response.ok) {
        const message =
          typeof json === "object" && json !== null
            ? String(
                (json as { error?: unknown }).error ??
                  (json as { message?: unknown }).message ??
                  text,
              )
            : text || response.statusText;

        if (attempt === 0 && response.status >= 500) {
          lastError = new ApifyApiError(response.status, message);
          continue;
        }

        throw new ApifyApiError(response.status, message);
      }

      return json;
    } catch (error) {
      if (error instanceof ApifyApiError && attempt === 0) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Apify request failed");
}

function parseRunEnvelope(json: unknown, label: string): ApifyRun {
  const data =
    typeof json === "object" && json !== null && "data" in json
      ? (json as { data: unknown }).data
      : json;
  return parseOrThrow(apifyRunResultSchema, data, label);
}

export function createApifyClient() {
  async function startRun(
    actorId: string,
    input: Record<string, unknown>,
    runOptions?: ApifyRunOptions,
  ): Promise<string> {
    const encoded = encodeActorId(actorId);
    const json = await apifyFetch(`/acts/${encoded}/runs${runOptionsQuery(runOptions)}`, {
      method: "POST",
      body: input,
    });
    const run = parseRunEnvelope(json, "apify:startRun");
    console.log(`[apify] started run ${run.id} actor=${actorId}`);
    return run.id;
  }

  async function waitForRun(runId: string, timeoutMs?: number): Promise<ApifyRun> {
    const timeout = timeoutMs ?? pollTimeoutMs();
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const json = await apifyFetch(`/actor-runs/${runId}`);
      const run = parseRunEnvelope(json, "apify:waitForRun");

      if (TERMINAL_STATUSES.has(run.status)) {
        return run;
      }

      await sleep(5000);
    }

    throw new ApifyTimeoutError(runId, timeout);
  }

  async function getDatasetItems(datasetId: string): Promise<Record<string, unknown>[]> {
    const json = await apifyFetch(`/datasets/${datasetId}/items`);
    return parseOrThrow(apifyDatasetItemsSchema, json, "apify:getDatasetItems");
  }

  async function runAndWait(
    actorId: string,
    input: Record<string, unknown>,
    timeoutMs?: number,
    runOptions?: ApifyRunOptions,
  ): Promise<ApifyRunWithItems> {
    const startedAt = Date.now();
    const runId = await startRun(actorId, input, runOptions);
    const run = await waitForRun(runId, timeoutMs);
    const durationMs = Date.now() - startedAt;

    let items: Record<string, unknown>[] = [];
    if (run.status === "SUCCEEDED" && run.defaultDatasetId) {
      items = await getDatasetItems(run.defaultDatasetId);
    }

    console.log(
      `[apify] run ${runId} actor=${actorId} status=${run.status} durationMs=${durationMs} items=${items.length}`,
    );

    if (run.status !== "SUCCEEDED") {
      throw new ApifyApiError(500, `Run ${runId} ended with status ${run.status}`);
    }

    return {
      runId,
      actorId,
      status: run.status,
      datasetId: run.defaultDatasetId ?? null,
      durationMs,
      itemCount: items.length,
      items,
    };
  }

  function itemsContain429(items: Record<string, unknown>[]): boolean {
    for (const item of items) {
      const status =
        (item.statusCode as unknown) ??
        (item.status_code as unknown) ??
        (item.httpStatusCode as unknown) ??
        (item.http_status_code as unknown);
      if (typeof status === "number" && status === 429) {
        return true;
      }
      const error = item.error;
      if (typeof error === "string" && error.includes("429")) {
        return true;
      }
      const message = item.message;
      if (typeof message === "string" && message.includes("429")) {
        return true;
      }
    }
    return false;
  }

  async function runAndWaitWith429Backoff(
    actorId: string,
    input: Record<string, unknown>,
    options: {
      label: string;
      urlsField: "urls" | "startUrls" | "targetUrls";
      shrinkTo: number;
      waitMs?: number;
      timeoutMs?: number;
    },
  ): Promise<ApifyRunWithItems> {
    try {
      const run = await runAndWait(actorId, input, options.timeoutMs);
      if (itemsContain429(run.items)) {
        throw new ApifyApiError(429, `${options.label}: items contained HTTP 429`);
      }
      return run;
    } catch (error) {
      const is429 =
        error instanceof ApifyApiError &&
        error.status === 429;

      const urls = input[options.urlsField];
      const canShrink =
        Array.isArray(urls) &&
        urls.length > options.shrinkTo &&
        options.shrinkTo > 0;

      if (!is429 || !canShrink) {
        throw error;
      }

      const waitMs = options.waitMs ?? 60_000;
      console.log(
        `[apify] 429 detected for ${options.label}; waiting ${waitMs}ms then retry with ${options.shrinkTo}/${urls.length} urls`,
      );
      await sleep(waitMs);

      const smallerInput = {
        ...input,
        [options.urlsField]: urls.slice(0, options.shrinkTo),
      } as Record<string, unknown>;

      const run = await runAndWait(actorId, smallerInput, options.timeoutMs);
      return run;
    }
  }

  return {
    startRun,
    waitForRun,
    getDatasetItems,
    runAndWait,
    runAndWaitWith429Backoff,
  };
}
