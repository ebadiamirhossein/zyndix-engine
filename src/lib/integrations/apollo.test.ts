import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { ApolloPlanError, createApolloClient } from "./apollo";

// Contract tests for Apollo Organization Enrichment (Session 12). fetch is
// mocked: no network, no credits. The fixture is synthetic.

const FIXTURES = join(__dirname, "__fixtures__", "apollo");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

const SENTINEL_KEY = "apollo_test_SENTINEL_0123456789";
const realFetch = globalThis.fetch;
const realKey = process.env.APOLLO_API_KEY;

type Call = { url: string; method: string; headers: Record<string, string> };

function mockFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  process.env.APOLLO_API_KEY = SENTINEL_KEY;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.APOLLO_API_KEY;
  else process.env.APOLLO_API_KEY = realKey;
});

describe("enrichOrganization", () => {
  test("GET /organizations/enrich?domain=… with the key in a header, never the URL", async () => {
    const calls = mockFetch(200, fixture("organization-enrich"));
    await createApolloClient().enrichOrganization(" Synthetic-Realty.example.invalid ");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "GET");
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/api/v1/organizations/enrich");
    assert.equal(url.searchParams.get("domain"), "synthetic-realty.example.invalid");
    assert.equal(calls[0]!.headers["x-api-key"], SENTINEL_KEY);
    assert.ok(!calls[0]!.url.includes(SENTINEL_KEY));
  });

  test("parses the location fields the timezone fill consumes", async () => {
    mockFetch(200, fixture("organization-enrich"));
    const org = await createApolloClient().enrichOrganization("synthetic-realty.example.invalid");
    assert.ok(org);
    assert.equal(org.state, "Texas");
    assert.equal(org.city, "El Paso");
    assert.equal(org.country, "United States");
  });

  test("no organization → null, not a throw", async () => {
    mockFetch(200, {});
    assert.equal(await createApolloClient().enrichOrganization("nothing.example.invalid"), null);
  });

  test("a wrong field type fails Zod instead of coercing", async () => {
    mockFetch(200, { organization: { id: "x", state: 42 } });
    await assert.rejects(createApolloClient().enrichOrganization("bad.example.invalid"));
  });

  test("403 → ApolloPlanError", async () => {
    mockFetch(403, { error: "api/v1/organizations/enrich is not accessible with this api_key" });
    await assert.rejects(createApolloClient().enrichOrganization("x.example.invalid"), ApolloPlanError);
  });

  test("empty domain is refused before any request", async () => {
    const calls = mockFetch(200, {});
    await assert.rejects(createApolloClient().enrichOrganization("  "));
    assert.equal(calls.length, 0);
  });
});
