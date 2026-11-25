import assert from "node:assert/strict";
import test from "node:test";
import { mountPage, paused, running, START } from "./scan-progress-harness";

// The whole live scan progress epic on one page at a time: the progress box,
// its rate-limit pause notice, the posters (Trakt) or the retained report
// (Plex), and the other kind's lock, shown together without clashing. Every
// server answer is faked; the clock moves only when a test moves it.

const TRAKT_RUN = { kind: "trakt", startedAt: START.toISOString() } as const;
const PLEX_RUN = { kind: "plex", startedAt: START.toISOString() } as const;
const RESUME_AT = new Date(START.getTime() + 90_000).toISOString();
const ANOTHER_SCAN = "Another scan is in progress";
const completed = { status: "completed", processed: 312, total: 312 };

// One show with its own Trakt poster, one that falls back to its Plex artwork.
const SEVERANCE = { title: "Severance", year: 2022, ids: { trakt: 1, slug: "severance", tmdb: 95396 }, images: { poster: ["media.trakt.tv/severance.webp"] } };
const ANDOR = { title: "Andor", year: 2022, ids: { trakt: 2, slug: "andor", tmdb: 83867 } };
const TRAKT_REPORT = { shows: [{ show: SEVERANCE }, { show: ANDOR }], missing: [SEVERANCE, ANDOR].map((show) => ({ show, season: 1, episode: 1, firstAired: "2001-01-01T20:00:00.000Z" })), lastScan: "2026-11-20T12:00:00.000Z" };
const ARTWORK = [{ ratingKey: "10", plexGuids: [], tmdbId: 83867, thumb: "/library/metadata/10/thumb/1700000000" }];

// Shows list alphabetically: Andor (Plex artwork), then Severance (its Trakt poster).
const ANDOR_POSTER = `/api/plex/poster?thumb=${encodeURIComponent(ARTWORK[0].thumb)}`;
const SEVERANCE_POSTER = `/api/poster?src=${encodeURIComponent(SEVERANCE.images.poster[0])}`;

const plexReport = (key: string, title: string) => ({ shows: [{ ratingKey: key, title, plexEpisodes: 3, missing: [{ season: 1, episode: 1, airDate: "2020-01-01", sources: ["TMDB"] }] }], lastScan: "2026-11-20T12:00:00.000Z", scanCache: {} });
const REPORT_A = plexReport("a", "Andor");
const REPORT_B = plexReport("b", "Bluey");

function pageParts(container: Element) {
  const button = () => container.querySelector<HTMLButtonElement>(".scan-panel button.primary");
  return {
    button: () => button()?.textContent?.replace("→", "").trim(),
    lockedLook: () => button()?.classList.contains("scan-locked") ?? false,
    lockLine: () => container.querySelector(".scan-run-lock")?.textContent || "",
    radar: () => container.querySelector(".radar small")?.textContent,
    notice: () => container.querySelector(".scan-progress-pause-text")?.textContent ?? null,
    countdown: () => container.querySelector(".scan-progress-countdown")?.textContent ?? null,
    dimmed: () => container.querySelector(".scan-progress")?.getAttribute("data-paused") === "true",
    heading: () => container.querySelector(".scan-progress-head strong")?.textContent,
    shows: () => Array.from(container.querySelectorAll(".show-name-button")).map((item) => item.textContent),
    posters: () => Array.from(container.querySelectorAll("article .show-index")).map((box) => box.querySelector("img")?.getAttribute("src") ?? null),
  };
}

test("a Trakt scan shows its progress box, pause notice and posters together, through to completion", async (t) => {
  const pausedScan = paused("Trakt", RESUME_AT);
  const page = await mountPage(t, "trakt", { activity: TRAKT_RUN, stateScan: pausedScan, statuses: [pausedScan], traktReport: TRAKT_REPORT, artwork: ARTWORK });
  const parts = pageParts(page.container);
  assert.ok(page.box(), "the progress box shows");
  assert.equal(parts.heading(), "Waiting");
  assert.ok(parts.dimmed(), "the show lines are dimmed");
  assert.equal(parts.notice(), "Paused: Trakt rate limit. Resumes at " + localTime(RESUME_AT) + ".");
  assert.equal(parts.countdown(), "1m 30s");
  assert.equal(parts.radar(), "PAUSED - RATE LIMIT");
  assert.equal(parts.button(), "Paused due to Rate Limit");
  assert.equal(parts.lockedLook(), false, "its own run never reads as another scan");
  assert.equal(parts.lockLine(), "");
  assert.deepEqual(parts.posters(), [ANDOR_POSTER, SEVERANCE_POSTER], "the report keeps its posters while the scan runs");

  page.nextStatuses(running({ activeShows: [{ key: "1", show: "Severance", phase: "air-dates" }] }));
  await page.advance();
  assert.equal(parts.notice(), null, "the pause notice clears with the pause");
  assert.equal(parts.heading(), "Now checking");
  assert.deepEqual(page.lines(), [["Severance", "Looking up air dates"]]);
  assert.equal(parts.button(), "Checking 41 of 312…");

  page.server.activity = null;
  page.nextStatuses(completed);
  await page.advance();
  assert.equal(page.box(), null, "the progress box goes away on completion");
  assert.equal(parts.button(), "Quick scan");
  assert.equal(parts.radar(), "MISSING");
  assert.deepEqual(parts.posters(), [ANDOR_POSTER, SEVERANCE_POSTER], "the report and its posters stay");
});

test("a Trakt page locked by a Plex scan run shows no progress box of its own, and keeps its report and posters", async (t) => {
  const page = await mountPage(t, "trakt", { activity: PLEX_RUN, traktReport: TRAKT_REPORT, artwork: ARTWORK });
  const parts = pageParts(page.container);
  assert.equal(page.box(), null);
  assert.equal(parts.button(), ANOTHER_SCAN);
  assert.ok(parts.lockedLook());
  assert.equal(parts.lockLine(), "A Plex scan is running. You can start a Trakt scan when it finishes.");
  assert.equal(parts.radar(), "MISSING");
  assert.deepEqual(parts.posters(), [ANDOR_POSTER, SEVERANCE_POSTER]);
});

test("a Plex scan shows its progress box and pause notice above the retained report, then replaces the report on completion", async (t) => {
  const pausedScan = paused("TMDB", RESUME_AT);
  const page = await mountPage(t, "plex", { activity: PLEX_RUN, statuses: [pausedScan], plexReport: REPORT_A });
  const parts = pageParts(page.container);
  assert.ok(page.box(), "the progress box shows");
  assert.ok(parts.dimmed());
  assert.equal(parts.notice(), "Paused: TMDB rate limit. Resumes at " + localTime(RESUME_AT) + ".");
  assert.equal(parts.radar(), "PAUSED · TMDB");
  assert.equal(parts.button(), "Paused for TMDB rate limit");
  assert.equal(parts.lockedLook(), false);
  assert.deepEqual(parts.shows(), ["Andor"], "the previous report stays below the box");

  // A running answer carrying another report cannot replace the retained one.
  page.server.plexReport = REPORT_B;
  page.nextStatuses(running({ currentPhase: "initializing" }));
  await page.advance();
  assert.equal(parts.notice(), null);
  assert.equal(page.box()?.querySelector(".scan-progress-solo")?.textContent, "Getting ready…");
  assert.deepEqual(parts.shows(), ["Andor"]);

  page.server.activity = null;
  page.nextStatuses({ status: "completed", processed: 188, total: 188 });
  await page.advance();
  assert.equal(page.box(), null);
  assert.equal(parts.button(), "New Plex search");
  assert.deepEqual(parts.shows(), ["Bluey"], "completion replaces the report");
});

test("a Plex page locked by a Trakt scan run shows no progress box of its own, and keeps its report", async (t) => {
  const page = await mountPage(t, "plex", { activity: TRAKT_RUN, plexReport: REPORT_A });
  const parts = pageParts(page.container);
  assert.equal(page.box(), null);
  assert.equal(parts.button(), ANOTHER_SCAN);
  assert.ok(parts.lockedLook());
  assert.equal(parts.lockLine(), "A Trakt scan is running. You can start a Plex scan when it finishes.");
  assert.deepEqual(parts.shows(), ["Andor"]);
});

/** The local HH:MM the pause notice shows for a moment. */
function localTime(iso: string) {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
