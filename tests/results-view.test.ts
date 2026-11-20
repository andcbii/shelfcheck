import assert from "node:assert/strict";
import test from "node:test";

import { addCalendarDays, localCalendarDate, resultsView, type AiredPolicy, type ResultsViewInput } from "../lib/results-view";

type Episode = { season: number; episode: number; airDate?: string };
type Show = { id: string; title: string; owned: number; missing: Episode[] };

const ownedPercent = (show: Show, episodes: readonly Episode[]) => show.owned / (show.owned + episodes.length);

function input(shows: Show[], overrides: Partial<ResultsViewInput<Show, Episode>> = {}): ResultsViewInput<Show, Episode> {
  return {
    shows: shows.map((show) => ({ key: show.id, title: show.title, source: show, episodes: show.missing })),
    ignoredShows: new Set(),
    ignoredSeasons: new Map(),
    airedPolicy: "show-all",
    airDateDelayDays: 0,
    today: "2026-11-20",
    search: "",
    sortField: "title",
    sortAscending: true,
    percent: ownedPercent,
    ...overrides,
  };
}

function shown(episode: Episode, airedPolicy: AiredPolicy, airDateDelayDays: number, today = "2026-11-20") {
  const view = resultsView(input([{ id: "a", title: "A", owned: 1, missing: [episode] }], { airedPolicy, airDateDelayDays, today }));
  return view.shows.length === 1;
}

test("an episode airing today shows with the switch off, with it on and no delay, and hides with a one-day delay", () => {
  const airsToday = { season: 1, episode: 1, airDate: "2026-11-20" };
  assert.equal(shown(airsToday, "show-all", 1), true);
  assert.equal(shown(airsToday, "aired-only", 0), true);
  assert.equal(shown(airsToday, "aired-only", 1), false);
});

test("an episode shows from exactly the day its air date plus delay reaches today", () => {
  const episode = { season: 1, episode: 1, airDate: "2026-08-08" };
  assert.equal(shown(episode, "aired-only", 2, "2026-08-09"), false);
  assert.equal(shown(episode, "aired-only", 2, "2026-08-10"), true);
  assert.equal(shown(episode, "aired-only", 2, "2026-08-11"), true);
});

test("with unaired episodes hidden, missing and malformed air dates hide under aired-only and show under aired-or-undated", () => {
  for (const airDate of [undefined, "", "unknown", "2026-02-30", "2026-13-01", "2026-8-8", "2026-08-08T00:00:00Z"]) {
    const episode = { season: 1, episode: 1, airDate };
    assert.equal(shown(episode, "show-all", 0), true, `show-all ${airDate}`);
    assert.equal(shown(episode, "aired-only", 0), false, `aired-only ${airDate}`);
    assert.equal(shown(episode, "aired-or-undated", 0), true, `aired-or-undated ${airDate}`);
  }
});

test("aired-or-undated still hides a dated episode until its air date plus delay", () => {
  const episode = { season: 1, episode: 1, airDate: "2026-11-20" };
  assert.equal(shown(episode, "aired-or-undated", 0), true);
  assert.equal(shown(episode, "aired-or-undated", 1), false);
});

test("calendar days add across month ends, year ends and leap days", () => {
  assert.equal(addCalendarDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addCalendarDays("2026-04-30", 1), "2026-05-01");
  assert.equal(addCalendarDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addCalendarDays("2026-12-25", 30), "2027-01-24");
  assert.equal(addCalendarDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addCalendarDays("2028-02-29", 1), "2028-03-01");
  assert.equal(addCalendarDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addCalendarDays("2100-02-28", 1), "2100-03-01");
  assert.equal(addCalendarDays("2000-02-28", 1), "2000-02-29");
  assert.equal(addCalendarDays("2026-03-08", 0), "2026-03-08");
});

test("the delay crosses a year end and a leap day on calendar days", () => {
  const newYearsEve = { season: 1, episode: 1, airDate: "2026-12-31" };
  assert.equal(shown(newYearsEve, "aired-only", 1, "2026-12-31"), false);
  assert.equal(shown(newYearsEve, "aired-only", 1, "2027-01-01"), true);
  const leapDayEve = { season: 1, episode: 1, airDate: "2028-02-28" };
  assert.equal(shown(leapDayEve, "aired-only", 2, "2028-02-29"), false);
  assert.equal(shown(leapDayEve, "aired-only", 2, "2028-03-01"), true);
});

test("a local calendar date is read from the date's local fields", () => {
  assert.equal(localCalendarDate(new Date(2026, 0, 31, 23, 59, 59)), "2026-01-31");
  assert.equal(localCalendarDate(new Date(2028, 1, 29, 0, 0, 0)), "2028-02-29");
});

const library: Show[] = [
  { id: "alpha", title: "Alpha", owned: 8, missing: [{ season: 1, episode: 3, airDate: "2026-01-01" }, { season: 2, episode: 1, airDate: "2026-01-02" }] },
  { id: "bravo", title: "Bravo", owned: 1, missing: [{ season: 1, episode: 2, airDate: "2026-01-03" }] },
  { id: "charlie", title: "Charlie", owned: 5, missing: [{ season: 3, episode: 1, airDate: "2026-01-04" }, { season: 3, episode: 2, airDate: "2026-01-05" }, { season: 4, episode: 1 }] },
];

const titlesOf = (view: { shows: { title: string }[] }) => view.shows.map((show) => show.title);

test("Active ignores remove whole shows and ignored seasons, and shows left empty disappear", () => {
  const view = resultsView(input(library, {
    ignoredShows: new Set(["bravo"]),
    ignoredSeasons: new Map([["alpha", new Set([1, 2])], ["charlie", new Set([3])]]),
  }));
  assert.deepEqual(titlesOf(view), ["Charlie"]);
  assert.deepEqual(view.shows[0].episodes, [{ season: 4, episode: 1 }]);
  assert.deepEqual(view.totals, { missingEpisodes: 1, shows: 1 });
});

test("a show left empty by the Aired rule disappears from the shows and the totals", () => {
  const view = resultsView(input(library, { airedPolicy: "aired-only", today: "2026-01-02" }));
  assert.deepEqual(titlesOf(view), ["Alpha"]);
  assert.deepEqual(view.totals, { missingEpisodes: 2, shows: 1 });
});

test("totals count Active ignores and the Aired rule but not the search", () => {
  const filters = { ignoredSeasons: new Map([["alpha", new Set([2])]]), airedPolicy: "aired-only" as const, today: "2026-01-04" };
  const unsearched = resultsView(input(library, filters));
  assert.deepEqual(unsearched.totals, { missingEpisodes: 3, shows: 3 });
  const searched = resultsView(input(library, { ...filters, search: "brav" }));
  assert.deepEqual(titlesOf(searched), ["Bravo"]);
  assert.deepEqual(searched.totals, { missingEpisodes: 3, shows: 3 });
  const nothing = resultsView(input(library, { ...filters, search: "no such show" }));
  assert.deepEqual(nothing.shows, []);
  assert.deepEqual(nothing.totals, { missingEpisodes: 3, shows: 3 });
});

const tied: Show[] = [
  { id: "c", title: "Charlie", owned: 1, missing: [{ season: 1, episode: 1 }] },
  { id: "a", title: "alpha", owned: 3, missing: [{ season: 1, episode: 1 }] },
  { id: "b", title: "Bravo", owned: 1, missing: [{ season: 1, episode: 1 }] },
  { id: "d", title: "Delta", owned: 0, missing: [{ season: 1, episode: 1 }] },
];

test("title sort follows the locale both ways", () => {
  assert.deepEqual(titlesOf(resultsView(input(tied, { sortField: "title", sortAscending: true }))), ["alpha", "Bravo", "Charlie", "Delta"]);
  assert.deepEqual(titlesOf(resultsView(input(tied, { sortField: "title", sortAscending: false }))), ["Delta", "Charlie", "Bravo", "alpha"]);
});

test("percent sort orders by percent with a title tie-break, and descending reverses both", () => {
  // Percents: Delta 0, Bravo 0.5, Charlie 0.5, alpha 0.75.
  assert.deepEqual(titlesOf(resultsView(input(tied, { sortField: "percent", sortAscending: true }))), ["Delta", "Bravo", "Charlie", "alpha"]);
  assert.deepEqual(titlesOf(resultsView(input(tied, { sortField: "percent", sortAscending: false }))), ["alpha", "Charlie", "Bravo", "Delta"]);
});

test("the percent is worked out from the episodes left after filtering, which can change the percent order", () => {
  const shows: Show[] = [
    // Unfiltered: Early 4/(4+1) = 0.8, Late 6/(6+4) = 0.6, so Late sorts first ascending.
    { id: "early", title: "Early", owned: 4, missing: [{ season: 1, episode: 1, airDate: "2026-01-01" }] },
    { id: "late", title: "Late", owned: 6, missing: [{ season: 1, episode: 1, airDate: "2026-01-01" }, { season: 1, episode: 2, airDate: "2026-12-01" }, { season: 1, episode: 3, airDate: "2026-12-02" }, { season: 1, episode: 4 }] },
  ];
  const unfiltered = resultsView(input(shows, { sortField: "percent" }));
  assert.deepEqual(titlesOf(unfiltered), ["Late", "Early"]);
  assert.deepEqual(unfiltered.shows.map((show) => show.percent), [0.6, 0.8]);
  // Filtered: Late keeps one episode, 6/(6+1) ≈ 0.857, so it now sorts after Early.
  const filtered = resultsView(input(shows, { sortField: "percent", airedPolicy: "aired-only", today: "2026-11-20" }));
  assert.deepEqual(titlesOf(filtered), ["Early", "Late"]);
  assert.deepEqual(filtered.shows.map((show) => show.percent), [0.8, 6 / 7]);
});

test("a percent that ignores the filtered episodes keeps its order whatever the filter", () => {
  const shows: Show[] = [
    { id: "x", title: "X", owned: 9, missing: [{ season: 1, episode: 1, airDate: "2026-01-01" }] },
    { id: "y", title: "Y", owned: 2, missing: [{ season: 1, episode: 1, airDate: "2026-01-01" }, { season: 1, episode: 2, airDate: "2026-12-01" }] },
  ];
  const fixed = { x: 0.3, y: 0.9 } as Record<string, number>;
  for (const airedPolicy of ["show-all", "aired-only"] as const) {
    const view = resultsView(input(shows, { sortField: "percent", airedPolicy, percent: (show) => fixed[show.id] }));
    assert.deepEqual(titlesOf(view), ["X", "Y"]);
  }
});

test("the view never changes its inputs", () => {
  const shows = structuredClone(library);
  const viewInput = input(shows, { ignoredShows: new Set(["bravo"]), ignoredSeasons: new Map([["alpha", new Set([1])]]), airedPolicy: "aired-only", today: "2026-01-04", sortField: "percent", sortAscending: false, search: "a" });
  const before = structuredClone({ shows: viewInput.shows, ignoredShows: viewInput.ignoredShows, ignoredSeasons: viewInput.ignoredSeasons });
  const view = resultsView(viewInput);
  assert.deepEqual({ shows: viewInput.shows, ignoredShows: viewInput.ignoredShows, ignoredSeasons: viewInput.ignoredSeasons }, before);
  assert.deepEqual(shows, library);
  assert.notEqual(view.shows[0].episodes, viewInput.shows.find((show) => show.key === view.shows[0].key)!.episodes);
});
