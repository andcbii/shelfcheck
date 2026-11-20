import assert from "node:assert/strict";
import test from "node:test";
import { localCalendarDate, nextLocalMidnight, resultsView } from "../../lib/results-view";

// Run by tests/fixed-zone-matrix.test.ts with TZ set before this file is imported.
const zone = process.env.TZ ?? "";
type ZoneCases = {
  /** UTC instants and the local calendar date each falls on. */
  localToday: [instant: string, today: string][];
  /** Local midnights starting a daylight-saving change day, and that day's length in hours. */
  dstDays: [localDate: [year: number, monthIndex: number, day: number], hours: number][];
};
const cases: Record<string, ZoneCases> = {
  "America/Los_Angeles": {
    localToday: [["2026-11-21T07:59:59.999Z", "2026-11-20"], ["2026-11-21T08:00:00.000Z", "2026-11-21"], ["2026-11-21T01:00:00.000Z", "2026-11-20"]],
    dstDays: [[[2026, 2, 8], 23], [[2026, 10, 1], 25]],
  },
  "Australia/Sydney": {
    localToday: [["2026-11-20T12:59:59.999Z", "2026-11-20"], ["2026-11-20T13:00:00.000Z", "2026-11-21"], ["2026-11-20T22:00:00.000Z", "2026-11-21"]],
    dstDays: [[[2026, 9, 4], 23], [[2026, 3, 5], 25]],
  },
};
const zoneCases = cases[zone];

test(`${zone} has fixed-zone cases`, () => assert.ok(zoneCases, `no cases for TZ=${zone}`));

test(`${zone}: local today is the calendar date in this zone, not in UTC`, () => {
  for (const [instant, today] of zoneCases.localToday) assert.equal(localCalendarDate(new Date(instant)), today, instant);
});

test(`${zone}: an episode airing on a date shows from local midnight of that date, not a day early or late`, () => {
  const shown = (moment: Date) => resultsView({
    shows: [{ key: "a", title: "A", source: null, episodes: [{ season: 1, airDate: "2026-11-21" }] }],
    ignoredShows: new Set(), ignoredSeasons: new Map(), airedPolicy: "aired-only", airDateDelayDays: 0,
    today: localCalendarDate(moment), search: "", sortField: "title", sortAscending: true, percent: () => 0,
  }).totals.missingEpisodes === 1;
  const midnight = new Date(2026, 10, 21);
  assert.equal(shown(new Date(midnight.getTime() - 1)), false);
  assert.equal(shown(midnight), true);
  assert.equal(shown(new Date(2026, 10, 20, 12)), false, "midday the day before, when the UTC date may already differ");
});

test(`${zone}: the next update is at the next local midnight, across daylight-saving changes`, () => {
  for (const [[year, month, day], hours] of zoneCases.dstDays) {
    const start = new Date(year, month, day);
    assert.equal(start.getHours(), 0);
    const next = nextLocalMidnight(start);
    assert.deepEqual([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()], [year, month, day + 1, 0, 0]);
    assert.equal(next.getTime() - start.getTime(), hours * 3_600_000, `${year}-${month + 1}-${day} lasts ${hours} hours`);
    const lateEvening = new Date(year, month, day, 23, 30);
    assert.equal(nextLocalMidnight(lateEvening).getTime(), next.getTime());
    assert.equal(localCalendarDate(new Date(next.getTime() - 1)), localCalendarDate(start));
  }
});
