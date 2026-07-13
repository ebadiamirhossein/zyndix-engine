import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  assessPersonNames,
  isValidPersonName,
  orgExcludedByKeywords,
} from "./filters";

const US_REALESTATE_EXCLUDE_KEYWORDS = [
  "recruiting",
  "recruitment",
  "staffing",
  "hotel",
  "hospitality",
  "resort",
  "job board",
  "onlinejobs",
  "journal",
  "publisher",
  "media",
  "news",
  "council",
  "association",
  "institute",
  "society",
  "software",
  "platform",
  "proptech",
];

describe("orgExcludedByKeywords", () => {
  test("rejects Phoenix Business Journal by name", () => {
    const excluded = orgExcludedByKeywords(
      { name: "Phoenix Business Journal", primary_domain: null, website_url: null },
      null,
      US_REALESTATE_EXCLUDE_KEYWORDS,
    );
    assert.equal(excluded, true);
  });

  test("rejects Austin Business Journal by name", () => {
    const excluded = orgExcludedByKeywords(
      { name: "Austin Business Journal", primary_domain: "bizjournals.com", website_url: null },
      "bizjournals.com",
      US_REALESTATE_EXCLUDE_KEYWORDS,
    );
    assert.equal(excluded, true);
  });

  test("rejects Residential Real Estate Council by name", () => {
    const excluded = orgExcludedByKeywords(
      { name: "Residential Real Estate Council", primary_domain: "crs.com", website_url: null },
      "crs.com",
      US_REALESTATE_EXCLUDE_KEYWORDS,
    );
    assert.equal(excluded, true);
  });

  test("allows a brokerage without excluded keywords", () => {
    const excluded = orgExcludedByKeywords(
      {
        name: "Stephan Group Real Estate Brokerage",
        primary_domain: "stephangrouprealestate.com",
        website_url: null,
      },
      "stephangrouprealestate.com",
      US_REALESTATE_EXCLUDE_KEYWORDS,
    );
    assert.equal(excluded, false);
  });
});

describe("isValidPersonName", () => {
  test("rejects backtick in name", () => {
    assert.equal(isValidPersonName("Jody`"), false);
  });

  test("rejects truncated consonant cluster", () => {
    assert.equal(isValidPersonName("Slr"), false);
  });

  test("allows normal names", () => {
    assert.equal(isValidPersonName("Michael"), true);
    assert.equal(isValidPersonName("O'Brien"), true);
    assert.equal(isValidPersonName("Mary-Jane"), true);
  });
});

describe("assessPersonNames", () => {
  test("flags do_not_contact when first name is invalid", () => {
    const result = assessPersonNames("Jody`", "Mir");
    assert.equal(result.nameSuspect, true);
    assert.equal(result.doNotContact, true);
  });

  test("does not set do_not_contact when only last name is invalid", () => {
    const result = assessPersonNames("Michael", "Slr");
    assert.equal(result.nameSuspect, true);
    assert.equal(result.doNotContact, false);
  });
});
