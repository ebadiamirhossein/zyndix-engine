import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import { bookingActionFor, planOutcome, rankCandidates } from "../meetings/core";
import {
  calendlyExternalId,
  computeCalendlySignature,
  parseSignatureHeader,
  SIGNATURE_TOLERANCE_MS,
  verifyCalendlySignature,
} from "./calendly";

// Pure rules of the Calendly webhook (09 §U8). No DB, no network.

const KEY = "k".repeat(40);
const NOW = new Date("2026-09-26T12:00:00.000Z");
const T = String(Math.floor(NOW.getTime() / 1000));
const BODY = JSON.stringify({ event: "invitee.created", created_at: NOW.toISOString(), payload: { uri: "https://api.calendly.com/x" } });

/** Independent reference: Calendly's doc — HMAC-SHA256 of t + "." + body, hex. */
function reference(key: string, t: string, body: string): string {
  return createHmac("sha256", key).update(`${t}.${body}`, "utf8").digest("hex");
}

describe("signature header parsing (t=…,v1=…)", () => {
  test("the documented format", () => {
    const parsed = parseSignatureHeader("t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd");
    assert.deepEqual(parsed, { t: "1492774577", v1: ["5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd"] });
  });
  test("whitespace and order tolerated; several v1 kept", () => {
    assert.deepEqual(parseSignatureHeader(" v1=aa , t=12 ,v1=bb"), { t: "12", v1: ["aa", "bb"] });
  });
  test("missing t, non-numeric t, duplicate t, missing v1 → null", () => {
    for (const h of ["v1=aa", "t=abc,v1=aa", "t=1,t=2,v1=aa", "t=1", "", "garbage", "t=,v1=aa", "t=1.5,v1=aa"]) {
      assert.equal(parseSignatureHeader(h), null, h);
    }
    assert.equal(parseSignatureHeader(null), null);
  });
});

describe("signature verification", () => {
  const sig = reference(KEY, T, BODY);
  const header = `t=${T},v1=${sig}`;
  test("computeCalendlySignature matches the documented construction (string and bytes)", () => {
    assert.equal(computeCalendlySignature(KEY, T, BODY), sig);
    assert.equal(computeCalendlySignature(KEY, T, new TextEncoder().encode(BODY)), sig);
  });
  test("valid signature at now → ok", () => {
    assert.deepEqual(verifyCalendlySignature({ header, rawBody: BODY, key: KEY, now: NOW }), { ok: true, timestamp: Number(T) * 1000 });
  });
  test("uppercase hex accepted; one matching v1 among several accepted", () => {
    assert.equal(verifyCalendlySignature({ header: `t=${T},v1=${sig.toUpperCase()}`, rawBody: BODY, key: KEY, now: NOW }).ok, true);
    assert.equal(verifyCalendlySignature({ header: `t=${T},v1=${"0".repeat(64)},v1=${sig}`, rawBody: BODY, key: KEY, now: NOW }).ok, true);
  });
  test("missing / malformed header", () => {
    assert.deepEqual(verifyCalendlySignature({ header: null, rawBody: BODY, key: KEY, now: NOW }), { ok: false, reason: "missing" });
    assert.deepEqual(verifyCalendlySignature({ header: `v1=${sig}`, rawBody: BODY, key: KEY, now: NOW }), { ok: false, reason: "malformed" });
  });
  test("tampered body, wrong key, wrong t, truncated or non-hex v1 → mismatch", () => {
    const cases = [
      { header, rawBody: BODY.replace("created", "canceled"), key: KEY },
      { header, rawBody: `${BODY} `, key: KEY },
      { header, rawBody: BODY, key: `${KEY}x` },
      { header: `t=${Number(T) + 1},v1=${sig}`, rawBody: BODY, key: KEY },
      { header: `t=${T},v1=${sig.slice(0, 63)}`, rawBody: BODY, key: KEY },
      { header: `t=${T},v1=${"z".repeat(64)}`, rawBody: BODY, key: KEY },
    ];
    for (const c of cases) assert.deepEqual(verifyCalendlySignature({ ...c, now: NOW }), { ok: false, reason: "mismatch" }, c.header);
  });
  test("3-minute tolerance, both directions (boundary inclusive)", () => {
    const at = (offsetMs: number) => {
      const t = String(Math.floor((NOW.getTime() + offsetMs) / 1000));
      return verifyCalendlySignature({ header: `t=${t},v1=${reference(KEY, t, BODY)}`, rawBody: BODY, key: KEY, now: NOW });
    };
    assert.equal(at(-SIGNATURE_TOLERANCE_MS).ok, true, "exactly 3 min old");
    assert.equal(at(SIGNATURE_TOLERANCE_MS).ok, true, "exactly 3 min ahead");
    assert.deepEqual(at(-SIGNATURE_TOLERANCE_MS - 1000), { ok: false, reason: "stale" }, "3 min 1 s old");
    assert.deepEqual(at(SIGNATURE_TOLERANCE_MS + 1000), { ok: false, reason: "stale" }, "3 min 1 s in the future");
    assert.deepEqual(at(-86_400_000), { ok: false, reason: "stale" }, "a day old (replay)");
  });
});

describe("dedupe id", () => {
  const inv = "https://api.calendly.com/scheduled_events/E1/invitees/I1";
  test("created and canceled of one invitee are distinct; same event is stable", () => {
    const created = calendlyExternalId({ event: "invitee.created", created_at: "a", payload: { uri: inv } });
    const canceled = calendlyExternalId({ event: "invitee.canceled", created_at: "a", payload: { uri: inv } });
    assert.equal(created, `invitee.created:${inv}`);
    assert.equal(canceled, `invitee.canceled:${inv}`);
    assert.equal(calendlyExternalId({ event: "invitee.created", created_at: "b", payload: { uri: inv, extra: 1 } }), created);
  });
  test("no-show keyed by the no_show uri when present, else invitee + created_at", () => {
    const ns = "https://api.calendly.com/invitee_no_shows/N1";
    assert.equal(calendlyExternalId({ event: "invitee_no_show.created", payload: { uri: inv, no_show: { uri: ns } } }), `invitee_no_show.created:${ns}`);
    assert.equal(calendlyExternalId({ event: "invitee_no_show.deleted", payload: { uri: inv, no_show: { uri: ns } } }), `invitee_no_show.deleted:${ns}`);
    assert.equal(
      calendlyExternalId({ event: "invitee_no_show.deleted", created_at: "2026-09-26T00:00:00Z", payload: { uri: inv, no_show: null } }),
      `invitee_no_show.deleted:${inv}:2026-09-26T00:00:00Z`,
    );
  });
  test("other events and junk are hashed whole; distinct junk is distinct", () => {
    const a = calendlyExternalId({ event: "event_type.created", payload: { uri: "x" } });
    const b = calendlyExternalId({ event: "event_type.created", payload: { uri: "y" } });
    assert.match(a, /^cal:[0-9a-f]{64}$/);
    assert.notEqual(a, b);
    assert.match(calendlyExternalId({ hello: "world" }), /^cal:/);
  });
});

describe("booking rules", () => {
  test("states with the new edge → meeting_booked (incl. manual_hold)", () => {
    for (const s of ["pending_approval", "approved", "queued", "sent", "replied", "classifying", "human_review", "no_reply", "sequence_done", "manual_hold"] as const) {
      assert.equal(bookingActionFor(s), "meeting_booked", s);
    }
  });
  test("already booked / handed off → record only; suppressed → record only", () => {
    assert.equal(bookingActionFor("meeting_booked"), "already_booked");
    assert.equal(bookingActionFor("handed_off"), "already_booked");
    assert.equal(bookingActionFor("suppressed"), "recorded_suppressed");
  });
  test("no edge → booking_unexpected_state", () => {
    for (const s of ["sourced", "enriching", "qualifying", "qualified", "verifying", "drafting", "bounced", "parked"] as const) {
      assert.equal(bookingActionFor(s), "booking_unexpected_state", s);
    }
  });
  test("several leads share the email: contacted first, then most recent, then id; suppressed last", () => {
    const ranked = rankCandidates([
      { id: "d", state: "suppressed" as const, updated_at: "2026-09-26T00:00:00Z" },
      { id: "c", state: "sourced" as const, updated_at: "2026-09-25T00:00:00Z" },
      { id: "b", state: "sent" as const, updated_at: "2026-09-01T00:00:00Z" },
      { id: "a", state: "no_reply" as const, updated_at: "2026-09-01T00:00:00Z" },
      { id: "e", state: "approved" as const, updated_at: "2026-09-20T00:00:00Z" },
      { id: "f", state: "replied" as const, updated_at: "2026-09-10T00:00:00Z" },
    ]);
    assert.deepEqual(ranked.map((r) => r.id), ["f", "a", "b", "e", "c", "d"]);
  });
});

describe("operator outcome (held / no-show)", () => {
  const past = { status: "scheduled" as const, start_at: "2026-09-25T10:00:00.000Z" };
  test("scheduled, past → held with recorder and timestamp", () => {
    const plan = planOutcome(past, "held", "operator", NOW);
    assert.equal(plan.ok, true);
    if (plan.ok) assert.deepEqual(plan.patch, { status: "held", outcome_recorded_by: "operator", outcome_recorded_at: NOW.toISOString(), no_show_at: null });
  });
  test("no_show sets no_show_at; same status → noop", () => {
    const plan = planOutcome(past, "no_show", "operator", NOW);
    assert.equal(plan.ok && plan.patch.no_show_at, NOW.toISOString());
    const again = planOutcome({ ...past, status: "no_show" }, "no_show", "operator", NOW);
    assert.equal(again.ok && again.noop, true);
  });
  test("canceled / rescheduled / future meetings refused", () => {
    assert.equal(planOutcome({ ...past, status: "canceled" }, "held", "op", NOW).ok, false);
    assert.equal(planOutcome({ ...past, status: "rescheduled" }, "held", "op", NOW).ok, false);
    assert.equal(planOutcome({ status: "scheduled", start_at: "2026-10-01T10:00:00.000Z" }, "held", "op", NOW).ok, false);
  });
});
