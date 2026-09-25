import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { instantlyExternalId, isAutoReply, parseReturnDate } from "./instantly";

// Pure rules of the Instantly webhook processor (09 §U6). No DB, no network.

const NOW = new Date("2026-09-29T06:00:00.000Z");
const reply = (extra: Record<string, unknown>) => ({ event_type: "reply_received", ...extra });

describe("auto-reply is NOT a reply (operator, Session 12)", () => {
  test("explicit event types", () => {
    assert.equal(isAutoReply({ event_type: "auto_reply_received" }), true);
    assert.equal(isAutoReply({ event_type: "lead_out_of_office" }), true);
  });
  test("provider flag on reply_received", () => {
    for (const flag of [true, 1, "1", "true"]) assert.equal(isAutoReply(reply({ is_auto_reply: flag })), true, String(flag));
    for (const flag of [false, 0, "0", null]) assert.equal(isAutoReply(reply({ is_auto_reply: flag })), false, String(flag));
  });
  test("unmistakable auto-reply subjects", () => {
    for (const s of ["Automatic reply: Your listing pages", "Auto-Reply: hi", "Autoreply", "Out of Office: back Monday", "OOO until Friday", "Auto: Re: hello"]) {
      assert.equal(isAutoReply(reply({ reply_subject: s })), true, s);
    }
  });
  test("anything unclear is a human reply (freezes) — the safe error", () => {
    for (const s of ["Re: Your listing pages", "Re: out of office hours pricing", "Thanks — automatic replies annoy me too", ""]) {
      assert.equal(isAutoReply(reply({ reply_subject: s })), false, s);
    }
    assert.equal(isAutoReply({ event_type: "lead_unsubscribed", reply_subject: "Automatic reply" }), false);
  });
});

describe("return date from an auto-reply body", () => {
  test("month-name forms, with and without a year", () => {
    assert.equal(parseReturnDate("I will be back on October 12, 2026.", NOW), "2026-10-12");
    assert.equal(parseReturnDate("Returning Oct 5th", NOW), "2026-10-05");
    assert.equal(parseReturnDate("I'm away until 5 October.", NOW), "2026-10-05");
    assert.equal(parseReturnDate("out of the office through the 3rd of November", NOW), "2026-11-03");
  });
  test("ISO and US numeric forms", () => {
    assert.equal(parseReturnDate("back 2026-10-07", NOW), "2026-10-07");
    assert.equal(parseReturnDate("Back in the office on 10/14/2026", NOW), "2026-10-14");
  });
  test("a date already past this year rolls to next year", () => {
    assert.equal(parseReturnDate("back on January 4", NOW), "2027-01-04");
  });
  test("no return cue, or an impossible date → null, never a guess", () => {
    assert.equal(parseReturnDate("Our office opened on October 12, 2010.", NOW), null);
    assert.equal(parseReturnDate("back on February 30, 2027", NOW), null);
    assert.equal(parseReturnDate("I am out of office.", NOW), null);
    assert.equal(parseReturnDate(null, NOW), null);
  });
});

describe("dedupe id (the payload carries no event id)", () => {
  const base = {
    timestamp: "2026-09-29T06:00:00.000Z",
    event_type: "reply_received",
    workspace: "ws",
    campaign_id: "c1",
    lead_email: "Lead@Example.invalid",
    email_id: "e1",
    reply_text: "hello",
  };
  test("stable across key order, case of the email, and non-identifying fields", () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    assert.equal(instantlyExternalId(base), instantlyExternalId(reordered));
    assert.equal(instantlyExternalId(base), instantlyExternalId({ ...base, lead_email: " lead@example.invalid ", reply_text: "different" }));
  });
  test("different event, email id or timestamp → different id", () => {
    const id = instantlyExternalId(base);
    assert.notEqual(instantlyExternalId({ ...base, event_type: "email_sent" }), id);
    assert.notEqual(instantlyExternalId({ ...base, email_id: "e2" }), id);
    assert.notEqual(instantlyExternalId({ ...base, timestamp: "2026-09-29T06:00:01.000Z" }), id);
    assert.match(id, /^ix:[0-9a-f]{64}$/);
  });
});
