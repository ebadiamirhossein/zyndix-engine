import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  accountHealth,
  createInstantlyClient,
  createInstantlyReadClient,
  INSTANTLY_MUTATING_OPERATIONS,
  INSTANTLY_READ_OPERATIONS,
  InstantlyContractError,
  InstantlyError,
  InstantlyPermanentError,
  InstantlyRetryableError,
  InstantlyUncertainOutcomeError,
  parseRetryAfter,
} from "./instantly";
import type { InstantlyAccount } from "./instantly-types";

// Contract suite for the Instantly adapter (09 §U4). fetch is mocked: no
// network, no DB. Fixtures are synthetic, shaped from the official OpenAPI spec.

const FIXTURES = join(__dirname, "__fixtures__", "instantly");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

const SENTINEL_KEY = "sk_test_SENTINEL_0123456789abcdefXYZ";
const CAMPAIGN = "00000000-0000-4000-8000-00000000c001";
const EMAIL = "prospect@target.example.invalid";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Handler = (call: Call) => Response | Promise<Response>;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch that answers from a queue of handlers and records every call. */
function mockFetch(...handlers: Handler[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

const sleeps: number[] = [];
function client(fetchImpl: typeof fetch) {
  return createInstantlyClient({
    apiKey: SENTINEL_KEY,
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

// Every thrown error is collected here for the secret-leak assertion at the end.
const thrown: unknown[] = [];
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    thrown.push(error);
    return error;
  }
  assert.fail("expected the call to throw");
}

const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const abortError = () => new DOMException("This operation was aborted", "AbortError");
const connectError = (code: string) =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`connect ${code} 203.0.113.1:443`), { code }),
  });

const enrollInput = { campaignId: CAMPAIGN, lead: { email: EMAIL, first_name: "Pat" } };

// ---------------------------------------------------------------------------

describe("09 §U4 DoD", () => {
  test("200 enroll parses to the typed created shape", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("leads-add-created")));
    const result = await client(impl).enrollLead(enrollInput);
    assert.equal(result.outcome, "created");
    assert.equal(result.outcome === "created" && result.leadId, "00000000-0000-4000-8000-00000000d001");
    assert.equal(calls.length, 1);
  });

  test("429 → InstantlyRetryableError carrying the parsed retry-after (seconds)", async () => {
    const { impl } = mockFetch(() => jsonResponse(429, fixture("error-429"), { "retry-after": "7" }));
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyRetryableError);
    assert.equal(error.retryAfterMs, 7000);
    assert.equal(error.status, 429);
  });

  test("429 → retry-after parsed from an HTTP-date", async () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    const { impl } = mockFetch(() => jsonResponse(429, fixture("error-429"), { "retry-after": at }));
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyRetryableError);
    assert.ok(error.retryAfterMs !== null && error.retryAfterMs > 25_000 && error.retryAfterMs <= 30_000);
  });

  test("429 without retry-after → retryAfterMs null (caller's backoff decides)", async () => {
    const { impl } = mockFetch(() => jsonResponse(429, fixture("error-429")));
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyRetryableError);
    assert.equal(error.retryAfterMs, null);
  });

  test("422 → InstantlyPermanentError kind validation", async () => {
    const { impl } = mockFetch(() => jsonResponse(422, fixture("error-422")));
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyPermanentError);
    assert.equal(error.kind, "validation");
    assert.equal(error.status, 422);
    assert.match(error.message, /must match format/);
  });

  test("400 → InstantlyPermanentError kind validation", async () => {
    const { impl } = mockFetch(() => jsonResponse(400, fixture("error-400")));
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyPermanentError);
    assert.equal(error.kind, "validation");
  });

  test("timeout raised after the request body flushed → InstantlyUncertainOutcomeError", async () => {
    let bodySeen: unknown;
    const { impl } = mockFetch((call) => {
      bodySeen = call.body; // the body was fully handed over
      throw timeoutError();
    });
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(bodySeen, "the mock consumed the request body");
    assert.ok(error instanceof InstantlyUncertainOutcomeError);
    assert.equal(error.reason, "timeout_after_dispatch");
    assert.deepEqual(error.fingerprint, { campaignId: CAMPAIGN, email: EMAIL });
  });

  test("abort raised after the request body flushed → InstantlyUncertainOutcomeError", async () => {
    const { impl } = mockFetch(() => {
      throw abortError();
    });
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyUncertainOutcomeError);
    assert.equal(error.reason, "timeout_after_dispatch");
  });

  test("unexpected field shape fails Zod and throws — no silent coercion", async () => {
    const { impl } = mockFetch(() => jsonResponse(200, fixture("accounts-bad-shape")));
    const error = await capture(() => client(impl).listAccounts());
    assert.ok(error instanceof InstantlyContractError);
    assert.ok(error instanceof InstantlyPermanentError);
    assert.equal(error.kind, "contract");
    assert.match(error.message, /items\.0\.status/);
  });

  test("missing items array fails Zod", async () => {
    const { impl } = mockFetch(() => jsonResponse(200, { data: [] }));
    const error = await capture(() => client(impl).listCampaigns());
    assert.ok(error instanceof InstantlyContractError);
  });
});

describe("taxonomy completeness", () => {
  test("the same timeout on a read → retryable, retried once", async () => {
    const { impl, calls } = mockFetch(() => {
      throw timeoutError();
    });
    const error = await capture(() => client(impl).listAccounts());
    assert.ok(error instanceof InstantlyRetryableError);
    assert.equal(calls.length, 2);
  });

  test("connect-phase ECONNREFUSED on a mutation → retryable, not uncertain", async () => {
    const { impl, calls } = mockFetch(() => {
      throw connectError("ECONNREFUSED");
    });
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyRetryableError);
    assert.ok(!(error instanceof InstantlyUncertainOutcomeError));
    assert.equal(calls.length, 1);
  });

  test("connect-phase ENOTFOUND on a mutation → retryable", async () => {
    const { impl } = mockFetch(() => {
      throw connectError("ENOTFOUND");
    });
    const error = await capture(() => client(impl).pauseCampaign(CAMPAIGN));
    assert.ok(error instanceof InstantlyRetryableError);
  });

  test("ECONNRESET after dispatch on a mutation → uncertain (network_after_dispatch)", async () => {
    const { impl } = mockFetch(() => {
      throw connectError("ECONNRESET");
    });
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyUncertainOutcomeError);
    assert.equal(error.reason, "network_after_dispatch");
  });

  test("500 on a mutation → uncertain (server_error), not retryable", async () => {
    const { impl } = mockFetch(() => jsonResponse(500, fixture("error-500")));
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyUncertainOutcomeError);
    assert.equal(error.reason, "server_error");
    assert.equal(error.status, 500);
  });

  test("502 on pauseCampaign → uncertain with the campaign fingerprint", async () => {
    const { impl } = mockFetch(() => jsonResponse(502, { message: "bad gateway" }));
    const error = await capture(() => client(impl).pauseCampaign(CAMPAIGN));
    assert.ok(error instanceof InstantlyUncertainOutcomeError);
    assert.deepEqual(error.fingerprint, { campaignId: CAMPAIGN });
  });

  test("500 on a read → retryable, retried once, then succeeds", async () => {
    sleeps.length = 0;
    const { impl, calls } = mockFetch(
      () => jsonResponse(500, fixture("error-500")),
      () => jsonResponse(200, fixture("accounts-page-2")),
    );
    const page = await client(impl).listAccounts();
    assert.equal(calls.length, 2);
    assert.equal(page.items.length, 1);
    assert.deepEqual(sleeps, [1000]);
  });

  test("500 twice on a read → retryable after exactly two calls", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(500, fixture("error-500")));
    const error = await capture(() => client(impl).getCurrentWorkspace());
    assert.ok(error instanceof InstantlyRetryableError);
    assert.equal(calls.length, 2);
  });

  test("a read retry honours retry-after, and skips a wait above 10s", async () => {
    sleeps.length = 0;
    const short = mockFetch(
      () => jsonResponse(429, fixture("error-429"), { "retry-after": "2" }),
      () => jsonResponse(200, fixture("campaigns-empty")),
    );
    await client(short.impl).listCampaigns();
    assert.deepEqual(sleeps, [2000]);

    const long = mockFetch(() => jsonResponse(429, fixture("error-429"), { "retry-after": "60" }));
    const error = await capture(() => client(long.impl).listCampaigns());
    assert.ok(error instanceof InstantlyRetryableError);
    assert.equal(long.calls.length, 1);
  });

  for (const [label, handler] of [
    ["429", () => jsonResponse(429, fixture("error-429"))],
    ["500", () => jsonResponse(500, fixture("error-500"))],
    [
      "timeout",
      () => {
        throw timeoutError();
      },
    ],
  ] as const) {
    test(`a mutation is never retried inside the adapter (${label}) — fetch called once`, async () => {
      const { impl, calls } = mockFetch(handler);
      await capture(() => client(impl).enrollLead(enrollInput));
      assert.equal(calls.length, 1);
    });
  }

  for (const [status, kind] of [
    [401, "auth"],
    [402, "plan"],
    [403, "scope"],
  ] as const) {
    test(`${status} → InstantlyPermanentError kind ${kind}`, async () => {
      const { impl, calls } = mockFetch(() => jsonResponse(status, fixture(`error-${status}`)));
      const error = await capture(() => client(impl).listAccounts());
      assert.ok(error instanceof InstantlyPermanentError);
      assert.equal(error.kind, kind);
      assert.equal(calls.length, 1, "permanent errors are not retried");
    });
  }

  test("404 → permanent validation", async () => {
    const { impl } = mockFetch(() => jsonResponse(404, { statusCode: 404, error: "Not Found", message: "Campaign not found" }));
    const error = await capture(() => client(impl).getCampaign(CAMPAIGN));
    assert.ok(error instanceof InstantlyPermanentError);
    assert.equal(error.kind, "validation");
  });

  test("2xx with a non-JSON body on a mutation → uncertain (unreadable_response)", async () => {
    const { impl } = mockFetch(() => new Response("<html>ok</html>", { status: 200 }));
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyUncertainOutcomeError);
    assert.equal(error.reason, "unreadable_response");
  });

  test("2xx with a body that fails Zod on a mutation → uncertain, never a contract error", async () => {
    const { impl } = mockFetch(() => jsonResponse(200, { status: "success", leads_uploaded: "1" }));
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyUncertainOutcomeError);
    assert.ok(!(error instanceof InstantlyContractError));
  });

  test("2xx whose body stream fails mid-read on a mutation → uncertain", async () => {
    const broken = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.reject(abortError()),
    } as unknown as Response;
    const { impl } = mockFetch(() => broken);
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyUncertainOutcomeError);
    assert.equal(error.reason, "unreadable_response");
  });

  test("200 enroll with inconsistent counts → uncertain (reconcile, do not resend)", async () => {
    const { impl } = mockFetch(() => jsonResponse(200, fixture("leads-add-inconsistent")));
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyUncertainOutcomeError);
    assert.deepEqual(error.fingerprint, { campaignId: CAMPAIGN, email: EMAIL });
  });

  test("missing key → permanent config error, and fetch is never called", async () => {
    const saved = process.env.INSTANTLY_API_KEY;
    delete process.env.INSTANTLY_API_KEY;
    try {
      const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("workspace")));
      const error = await capture(() => createInstantlyClient({ fetch: impl }).getCurrentWorkspace());
      assert.ok(error instanceof InstantlyPermanentError);
      assert.equal(error.kind, "config");
      assert.equal(calls.length, 0);
    } finally {
      if (saved !== undefined) process.env.INSTANTLY_API_KEY = saved;
    }
  });

  test("enroll input without an email → permanent validation, no network", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("leads-add-created")));
    const error = await capture(() =>
      client(impl).enrollLead({ campaignId: CAMPAIGN, lead: { email: "  " } }),
    );
    assert.ok(error instanceof InstantlyPermanentError);
    assert.equal(calls.length, 0);
  });

  test("every error class extends InstantlyError", () => {
    for (const error of thrown) assert.ok(error instanceof InstantlyError, String(error));
  });
});

describe("behaviour", () => {
  test("skipped duplicate → { outcome: skipped, reason: already_enrolled }", async () => {
    const { impl } = mockFetch(() => jsonResponse(200, fixture("leads-add-skipped-duplicate")));
    const result = await client(impl).enrollLead(enrollInput);
    assert.deepEqual([result.outcome, result.outcome === "skipped" && result.reason], ["skipped", "already_enrolled"]);
  });

  test("blocklisted → { outcome: skipped, reason: blocklisted }", async () => {
    const { impl } = mockFetch(() => jsonResponse(200, fixture("leads-add-blocklisted")));
    const result = await client(impl).enrollLead(enrollInput);
    assert.deepEqual([result.outcome, result.outcome === "skipped" && result.reason], ["skipped", "blocklisted"]);
  });

  test("enroll request shape: POST /api/v2/leads/add, Bearer auth, workspace dedupe by default", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("leads-add-created")));
    await client(impl).enrollLead({ ...enrollInput, lead: { ...enrollInput.lead, email: `  ${EMAIL} ` } });
    const [call] = calls;
    assert.equal(call.method, "POST");
    assert.equal(call.url, "https://api.instantly.ai/api/v2/leads/add");
    assert.equal(call.headers.Authorization, `Bearer ${SENTINEL_KEY}`);
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(call.body, {
      campaign_id: CAMPAIGN,
      leads: [{ email: EMAIL, first_name: "Pat" }],
      skip_if_in_workspace: true,
      skip_if_in_campaign: true,
      verify_leads_on_import: false,
    });
  });

  test("dedupe: campaign turns workspace skipping off but keeps campaign skipping", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("leads-add-created")));
    await client(impl).enrollLead({ ...enrollInput, dedupe: "campaign" });
    const body = calls[0].body as Record<string, unknown>;
    assert.equal(body.skip_if_in_workspace, false);
    assert.equal(body.skip_if_in_campaign, true);
  });

  test("pause and delete send no body and no content-type", async () => {
    const pause = mockFetch(() => jsonResponse(200, fixture("campaign")));
    const campaign = await client(pause.impl).pauseCampaign(CAMPAIGN);
    assert.equal(campaign.status, 2);
    assert.equal(pause.calls[0].url, `https://api.instantly.ai/api/v2/campaigns/${CAMPAIGN}/pause`);
    assert.equal(pause.calls[0].body, undefined);
    assert.equal(pause.calls[0].headers["content-type"], undefined);

    const del = mockFetch(() => jsonResponse(200, fixture("lead-deleted")));
    await client(del.impl).deleteLead("00000000-0000-4000-8000-00000000d001");
    assert.equal(del.calls[0].method, "DELETE");
    assert.equal(del.calls[0].body, undefined);
  });

  test("addBlockListEntry posts bl_value", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("block-list-entry")));
    const entry = await client(impl).addBlockListEntry(` ${EMAIL} `);
    assert.equal(entry.is_domain, false);
    assert.deepEqual(calls[0].body, { bl_value: EMAIL });
  });

  test("findLeadInCampaign matches case-insensitively and posts campaign + contacts", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("leads-list-found")));
    const lead = await client(impl).findLeadInCampaign(CAMPAIGN, EMAIL);
    assert.equal(lead?.id, "00000000-0000-4000-8000-00000000d001");
    assert.deepEqual(calls[0].body, { campaign: CAMPAIGN, contacts: [EMAIL], limit: 10 });
  });

  test("findLeadInCampaign returns null when absent", async () => {
    const { impl } = mockFetch(() => jsonResponse(200, fixture("campaigns-empty")));
    assert.equal(await client(impl).findLeadInCampaign(CAMPAIGN, EMAIL), null);
  });

  test("listAllAccounts follows next_starting_after across two pages", async () => {
    const { impl, calls } = mockFetch(
      () => jsonResponse(200, fixture("accounts-page-1")),
      () => jsonResponse(200, fixture("accounts-page-2")),
    );
    const result = await client(impl).listAllAccounts();
    assert.equal(result.items.length, 3);
    assert.equal(result.truncated, false);
    assert.equal(calls.length, 2);
    assert.equal(
      new URL(calls[1].url).searchParams.get("starting_after"),
      "2026-09-24T09:01:00.000Z&sender.two@alpha.example.invalid",
    );
    assert.equal(new URL(calls[0].url).searchParams.get("limit"), "100");
  });

  test("listAllAccounts stops at the page cap and says so", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("accounts-page-1")));
    const result = await client(impl).listAllAccounts({ maxPages: 3 });
    assert.equal(calls.length, 3);
    assert.equal(result.truncated, true);
  });

  test("getAccount url-encodes the email", async () => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse(200, (fixture("accounts-page-1") as { items: unknown[] }).items[0]),
    );
    await client(impl).getAccount("a+b@alpha.example.invalid");
    assert.equal(calls[0].url, "https://api.instantly.ai/api/v2/accounts/a%2Bb%40alpha.example.invalid");
  });

  test("getWarmupAnalytics parses the aggregate and rejects an empty list without a call", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("warmup-analytics")));
    const analytics = await client(impl).getWarmupAnalytics(["sender.one@alpha.example.invalid"]);
    assert.equal(analytics.aggregate_data["sender.one@alpha.example.invalid"].health_score, 100);
    await assert.rejects(client(impl).getWarmupAnalytics([]), InstantlyPermanentError);
    assert.equal(calls.length, 1);
  });

  test("workspace and webhook event types parse", async () => {
    const { impl } = mockFetch(
      () => jsonResponse(200, fixture("workspace")),
      () => jsonResponse(200, fixture("webhook-event-types")),
    );
    const c = client(impl);
    assert.equal((await c.getCurrentWorkspace()).name, "Fixture Workspace");
    assert.equal((await c.listWebhookEventTypes()).event_types.length, 1);
  });

  test("parseRetryAfter: seconds, fractional, date, past date, garbage, absent", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    assert.equal(parseRetryAfter("3", now), 3000);
    assert.equal(parseRetryAfter("1.5", now), 1500);
    assert.equal(parseRetryAfter("Fri, 25 Sep 2026 12:00:10 GMT", now), 10_000);
    assert.equal(parseRetryAfter("Fri, 25 Sep 2026 11:00:00 GMT", now), 0);
    assert.equal(parseRetryAfter("soon", now), null);
    assert.equal(parseRetryAfter(null, now), null);
  });
});

describe("U5 additions: campaigns and threaded replies", () => {
  test("createCampaign posts the payload and parses the detail shape", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("campaign-created")));
    const created = await client(impl).createCampaign({
      name: "zx-sender-amir@sender.example.invalid",
      campaign_schedule: {
        schedules: [
          {
            name: "engine-owned",
            timing: { from: "00:00", to: "23:59" },
            days: { "0": true, "1": true, "2": true, "3": true, "4": true, "5": true, "6": true },
            timezone: "Europe/Helsinki",
          },
        ],
      },
      sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: "{{zx_subject}}", body: "{{zx_body}}" }] }] }],
      email_list: ["amir@sender.example.invalid"],
      open_tracking: false,
      link_tracking: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.ok(calls[0].url.endsWith("/api/v2/campaigns"));
    assert.deepEqual((calls[0].body as { email_list: string[] }).email_list, ["amir@sender.example.invalid"]);
    assert.deepEqual(created.email_list, ["amir@sender.example.invalid"]);
    assert.equal(created.open_tracking, false);
    assert.equal(created.first_email_text_only, true);
  });

  test("createCampaign with an empty email_list → permanent validation, no network", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, {}));
    const error = await capture(() =>
      client(impl).createCampaign({
        name: "x",
        campaign_schedule: { schedules: [] },
        sequences: [],
        email_list: [],
        open_tracking: false,
      }),
    );
    assert.ok(error instanceof InstantlyPermanentError);
    assert.equal(calls.length, 0);
  });

  test("createCampaign 500 → uncertain (a campaign may exist), fetch called once", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(500, fixture("error-500")));
    const error = await capture(() =>
      client(impl).createCampaign({
        name: "x",
        campaign_schedule: { schedules: [] },
        sequences: [],
        email_list: ["a@b.example.invalid"],
        open_tracking: false,
      }),
    );
    assert.ok(error instanceof InstantlyUncertainOutcomeError);
    assert.equal(calls.length, 1);
  });

  test("replyToEmail posts eaccount + reply_to_uuid and parses the thread id", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("email-reply-sent")));
    const sent = await client(impl).replyToEmail({
      eaccount: "amir@sender.example.invalid",
      replyToUuid: "00000000-0000-4000-8000-0000000e0001",
      subject: "Re: Fixture subject",
      body: { html: "Following up." },
    });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/api/v2/emails/reply"));
    assert.deepEqual(calls[0].body, {
      eaccount: "amir@sender.example.invalid",
      reply_to_uuid: "00000000-0000-4000-8000-0000000e0001",
      subject: "Re: Fixture subject",
      body: { html: "Following up." },
    });
    assert.equal(sent.thread_id, "00000000-0000-4000-8000-0000000t0001");
  });

  test("replyToEmail timeout after dispatch → uncertain, never retried", async () => {
    const { impl, calls } = mockFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const error = await capture(() =>
      client(impl).replyToEmail({
        eaccount: "amir@sender.example.invalid",
        replyToUuid: "00000000-0000-4000-8000-0000000e0001",
        subject: "Re: x",
        body: { text: "y" },
      }),
    );
    assert.ok(error instanceof InstantlyUncertainOutcomeError);
    assert.equal(calls.length, 1);
  });

  test("replyToEmail without a reply target → permanent validation, no network", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, {}));
    const error = await capture(() =>
      client(impl).replyToEmail({ eaccount: "a@b.example.invalid", replyToUuid: " ", subject: "s", body: { text: "b" } }),
    );
    assert.ok(error instanceof InstantlyPermanentError);
    assert.equal(calls.length, 0);
  });

  test("listEmails sends the filters as query params and parses items", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse(200, fixture("emails-list")));
    const page = await client(impl).listEmails({
      lead: EMAIL,
      campaignId: CAMPAIGN,
      emailType: "sent",
      minTimestampCreated: "2026-09-24T00:00:00.000Z",
    });
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/api/v2/emails");
    assert.equal(url.searchParams.get("lead"), EMAIL);
    assert.equal(url.searchParams.get("campaign_id"), CAMPAIGN);
    assert.equal(url.searchParams.get("email_type"), "sent");
    assert.equal(page.items[0].ue_type, 1);
    assert.equal(page.items[0].thread_id, "00000000-0000-4000-8000-0000000t0001");
  });

  test("getCampaign still parses a campaign without the detail fields", async () => {
    const { impl } = mockFetch(() => jsonResponse(200, fixture("campaign")));
    const campaign = await client(impl).getCampaign(CAMPAIGN);
    assert.equal(campaign.email_list, undefined);
    assert.equal(campaign.open_tracking, true);
  });
});

describe("read-only client", () => {
  test("exposes every read operation and no mutating operation", () => {
    const read = createInstantlyReadClient({ apiKey: SENTINEL_KEY }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(read).sort(), [...INSTANTLY_READ_OPERATIONS].sort());
    for (const name of INSTANTLY_MUTATING_OPERATIONS) assert.equal(read[name], undefined, name);
  });

  test("the full client's operations are exactly read ∪ mutating", () => {
    const full = createInstantlyClient({ apiKey: SENTINEL_KEY });
    assert.deepEqual(
      Object.keys(full).sort(),
      [...INSTANTLY_READ_OPERATIONS, ...INSTANTLY_MUTATING_OPERATIONS].sort(),
    );
  });
});

describe("accountHealth", () => {
  const base = (fixture("accounts-page-1") as { items: InstantlyAccount[] }).items[0];
  const cases: Array<[string, Partial<InstantlyAccount>, number | null | undefined, string, string[]]> = [
    ["healthy", {}, 100, "healthy", []],
    ["paused account", { status: 2 }, 100, "unhealthy", ["account_paused"]],
    ["connection error", { status: -1 }, 100, "unhealthy", ["account_connection_error"]],
    ["maintenance", { status: 3 }, 100, "degraded", ["account_maintenance_paused"]],
    ["warmup banned", { warmup_status: -1 }, 100, "unhealthy", ["warmup_banned"]],
    ["warmup paused", { warmup_status: 0 }, 100, "degraded", ["warmup_paused"]],
    ["setup pending", { setup_pending: true }, 100, "unhealthy", ["setup_pending"]],
    ["missing score → unknown, never 0", { stat_warmup_score: null }, undefined, "unknown", ["no_warmup_score"]],
    ["unknown status code", { status: 42 }, 100, "unknown", ["account_status_unknown(42)"]],
  ];
  for (const [name, patch, score, verdict, reasons] of cases) {
    test(name, () => {
      const warmup = score === undefined ? null : { health_score: score };
      const health = accountHealth({ ...base, ...patch }, warmup);
      assert.equal(health.verdict, verdict);
      assert.deepEqual(health.reasons, reasons);
    });
  }

  test("missing score stays null, not 0", () => {
    assert.equal(accountHealth({ ...base, stat_warmup_score: null }).warmupScore, null);
  });

  test("score threshold is caller policy: judged only when given", () => {
    assert.equal(accountHealth(base, { health_score: 60 }).verdict, "healthy");
    const judged = accountHealth(base, { health_score: 60 }, { minWarmupScore: 80 });
    assert.equal(judged.verdict, "degraded");
    assert.deepEqual(judged.reasons, ["warmup_score_below_80"]);
  });

  test("worst reason wins", () => {
    const health = accountHealth({ ...base, status: 3, warmup_status: -3 }, { health_score: 100 });
    assert.equal(health.verdict, "unhealthy");
    assert.deepEqual(health.reasons, ["account_maintenance_paused", "warmup_permanent_suspension"]);
  });
});

describe("secrets", () => {
  test("a key echoed back in an error body is redacted", async () => {
    const { impl } = mockFetch(() =>
      jsonResponse(400, { statusCode: 400, error: "Bad Request", message: `bad header Bearer ${SENTINEL_KEY} (${SENTINEL_KEY})` }),
    );
    const error = await capture(() => client(impl).enrollLead(enrollInput));
    assert.ok(error instanceof InstantlyPermanentError);
    assert.match(error.message, /\[redacted\]/);
  });

  test("the key appears in no message, String(), JSON or stack of any error thrown in this suite", () => {
    assert.ok(thrown.length >= 30, `collected ${thrown.length} errors`);
    for (const error of thrown) {
      const e = error as Error;
      for (const surface of [e.message, String(e), JSON.stringify(e), e.stack ?? ""]) {
        assert.ok(!surface.includes(SENTINEL_KEY), `leak in ${e.name}: ${surface.slice(0, 120)}`);
        assert.ok(!surface.includes("SENTINEL_0123456789"), `partial leak in ${e.name}`);
      }
    }
  });
});
