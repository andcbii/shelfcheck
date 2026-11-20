import assert from "node:assert/strict";
import test from "node:test";
import { traktLocalAirDate } from "../../lib/trakt-model";

// Run by tests/fixed-zone-matrix.test.ts with TZ set before this file is imported.
const zone = process.env.TZ ?? "";
/** Trakt first_aired timestamps (UTC) and the local calendar date each falls on in the zone. */
const cases: Record<string, [firstAired: string, localDate: string][]> = {
  "America/Los_Angeles": [
    ["2026-11-21T00:30:00.000Z", "2026-11-20"],
    ["2026-11-21T08:00:00.000Z", "2026-11-21"],
    ["2026-03-08T09:59:00.000Z", "2026-03-08"],
  ],
  "Australia/Sydney": [
    ["2026-11-20T22:00:00.000Z", "2026-11-21"],
    ["2026-11-20T12:59:00.000Z", "2026-11-20"],
    ["2026-04-04T14:30:00.000Z", "2026-04-05"],
  ],
};
const zoneCases = cases[zone];

test(`${zone} has Trakt timestamp cases`, () => assert.ok(zoneCases, `no cases for TZ=${zone}`));

test(`${zone}: a Trakt first_aired timestamp becomes the local calendar date, not its UTC date`, () => {
  for (const [firstAired, localDate] of zoneCases) assert.equal(traktLocalAirDate(firstAired), localDate, firstAired);
});

test(`${zone}: a missing or unreadable first_aired has no air date`, () => {
  for (const value of [undefined, "", "not a date"]) assert.equal(traktLocalAirDate(value), undefined, String(value));
});
