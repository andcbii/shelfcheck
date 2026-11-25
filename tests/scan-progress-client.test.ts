import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { active, mountPage, mountPaused, paused, pending, running, SHOWS, START } from "./scan-progress-harness";
import { PLEX_SCAN_PREPARING_BUTTON_LABEL, SCAN_NO_SHOWS_TO_COMPARE_WORDING } from "../lib/scan-run-activity";

// The progress box under each report heading shows the shows the Scan run is
// checking and their step, from the page's status answers. Every server answer
// is faked; the clock (Date and the page's window timers) moves only when a
// test moves it, one second at a time.

test("a Trakt page opened mid-scan lists the shows being checked before its first poll answers", async (t) => {
  const firstPoll = pending();
  const shows = active([SHOWS[0], "collection-progress"], [SHOWS[1], "air-dates"], [SHOWS[2], "poster"], [SHOWS[3], "collection-progress"], [SHOWS[4], "starting"], [SHOWS[5], "collection-progress"]);
  const page = await mountPage(t, "trakt", { stateScan: running({ activeShows: shows }), statuses: [firstPoll.promise] });

  assert.equal(page.box()?.querySelector(".scan-progress-head strong")?.textContent, "Now checking");
  assert.match(page.box()?.textContent || "", /Progress is saved periodically\./);
  assert.deepEqual(page.lines(), [
    ["Severance", "Checking your Trakt collection"],
    ["The Bear", "Looking up air dates"],
    ["Slow Horses", "Fetching the poster"],
    ["Andor", "Checking your Trakt collection"],
    ["Shrinking", "Starting"],
    ["Fallout", "Checking your Trakt collection"],
  ]);
  assert.doesNotMatch(page.box()?.textContent || "", /Comparing show|41 of 312/, "the box does not repeat the scan button's count");
  assert.match(page.container.querySelector("button.primary")?.textContent || "", /^Checking 41 of 312/, "the scan button still shows the count");
  assert.equal((page.box()?.querySelector(".scan-progress-bar") as HTMLElement | null)?.style.width, "13%", "the acid bar stays along the bottom");
});

test("each Trakt step reads in plain English, and an unknown step reads neutrally", async (t) => {
  const cases: [phase: string, wording: string][] = [
    ["collection-progress", "Checking your Trakt collection"],
    ["air-dates", "Looking up air dates"],
    ["poster", "Fetching the poster"],
    ["starting", "Starting"],
    ["a-step-added-later", "Working on it"],
  ];
  for (const [phase, wording] of cases) {
    await t.test(phase, async (t) => {
      const scan = running({ activeShows: active(["Severance", phase]) });
      const page = await mountPage(t, "trakt", { stateScan: scan, statuses: [scan] });
      assert.deepEqual(page.lines(), [["Severance", wording]]);
    });
  }
});

test("a Trakt show leaves the box or changes step on the next status answer", async (t) => {
  const first = running({ activeShows: active(["Severance", "collection-progress"], ["The Bear", "air-dates"]) });
  const page = await mountPage(t, "trakt", { stateScan: first, statuses: [first] });
  assert.deepEqual(page.lines(), [["Severance", "Checking your Trakt collection"], ["The Bear", "Looking up air dates"]]);

  page.nextStatuses(running({ processed: 42, activeShows: [{ key: "2", show: "The Bear", phase: "poster" }] }));
  await page.advance();
  assert.deepEqual(page.lines(), [["The Bear", "Fetching the poster"]]);
});

test("the Trakt box shows at most six shows, as many as a Trakt scan checks at once", async (t) => {
  const scan = running({ activeShows: active(...SHOWS.map((show) => [show, "starting"] as [string, string])) });
  const page = await mountPage(t, "trakt", { stateScan: scan, statuses: [scan] });
  assert.deepEqual(page.lines().map(([show]) => show), SHOWS.slice(0, 6));
});

test("an older saved Trakt status without show details still shows the box", async (t) => {
  const scan = { status: "running", processed: 3, total: 12 };
  const page = await mountPage(t, "trakt", { stateScan: scan, statuses: [scan] });
  assert.ok(page.box(), "the box shows");
  assert.equal(page.box()?.querySelector(".scan-progress-head strong")?.textContent, "Now checking");
  assert.deepEqual(page.lines(), []);

  page.nextStatuses({ ...scan, activeShows: [null, { key: 1 }, "Severance", { key: "2", show: "The Bear", phase: "air-dates" }] });
  await page.advance();
  assert.deepEqual(page.lines(), [["The Bear", "Looking up air dates"]], "malformed entries are skipped");
});

test("the Trakt box goes away when the scan completes or fails", async (t) => {
  await t.test("completes", async (t) => {
    const scan = running({ activeShows: active(["Severance", "poster"]) });
    const page = await mountPage(t, "trakt", { stateScan: scan, statuses: [scan] });
    assert.ok(page.box());
    page.nextStatuses({ status: "completed", processed: 312, total: 312 });
    await page.advance();
    assert.equal(page.box(), null);
  });
  await t.test("fails", async (t) => {
    const scan = running({ activeShows: active(["Severance", "poster"]) });
    const page = await mountPage(t, "trakt", { stateScan: scan, statuses: [scan] });
    page.nextStatuses({ status: "error", processed: 41, total: 312, error: "Trakt is unreachable." });
    await page.advance();
    assert.equal(page.box(), null);
    assert.match(page.container.querySelector(".error")?.textContent || "", /Trakt is unreachable\./);
  });
});

test("a Plex page opened mid-scan lists the shows being checked, then follows the next status answer", async (t) => {
  const nextPoll = pending();
  const first = running({ processed: 72, total: 188, currentPhase: "processing-3-shows", activeShows: active(["Doctor Who (2005)", "episode-crosswalk"], ["Bluey", "tmdb-show-and-seasons"], ["The Expanse", "plex-inventory"]) });
  const page = await mountPage(t, "plex", { statuses: [first, nextPoll.promise] });

  assert.equal(page.box()?.querySelector(".scan-progress-head strong")?.textContent, "Now checking");
  assert.match(page.box()?.textContent || "", /Progress is saved periodically\./);
  assert.deepEqual(page.lines(), [
    ["Doctor Who (2005)", "Matching episode numbers between providers"],
    ["Bluey", "Getting the episode list from TMDB"],
    ["The Expanse", "Reading episodes in Plex"],
  ]);
  assert.doesNotMatch(page.box()?.textContent || "", /SCANNING PLEX AND PROVIDERS|72 of 188/, "the box does not repeat the scan button's count");
  assert.equal((page.box()?.querySelector(".scan-progress-bar") as HTMLElement | null)?.style.width, "38%");

  nextPoll.resolve(running({ processed: 73, total: 188, activeShows: active(["Bluey", "tvdb-series-and-episodes"], ["Silo", "starting"]) }));
  await page.advance();
  assert.deepEqual(page.lines(), [["Bluey", "Getting the episode list from TVDB"], ["Silo", "Starting"]]);
});

test("each Plex step reads in plain English", async (t) => {
  const cases: [phase: string, wording: string][] = [
    ["plex-inventory", "Reading episodes in Plex"],
    ["tmdb-show-and-seasons", "Getting the episode list from TMDB"],
    ["tvdb-series-and-episodes", "Getting the episode list from TVDB"],
    ["episode-crosswalk", "Matching episode numbers between providers"],
    ["starting", "Starting"],
    ["a-step-added-later", "Working on it"],
  ];
  for (const [phase, wording] of cases) {
    await t.test(phase, async (t) => {
      const scan = running({ activeShows: active(["Bluey", phase]) });
      const page = await mountPage(t, "plex", { statuses: [scan] });
      assert.deepEqual(page.lines(), [["Bluey", wording]]);
    });
  }
});

test("the Plex box shows at most three shows, as many as a Plex scan checks at once", async (t) => {
  const scan = running({ activeShows: active(...SHOWS.slice(0, 4).map((show) => [show, "plex-inventory"] as [string, string])) });
  const page = await mountPage(t, "plex", { statuses: [scan] });
  assert.deepEqual(page.lines().map(([show]) => show), SHOWS.slice(0, 3));
});

test("a Plex page opened before the first show starts says it is getting ready, until a show starts", async (t) => {
  const nextPoll = pending();
  const page = await mountPage(t, "plex", { statuses: [running({ processed: 0, total: 0, currentPhase: "initializing" }), nextPoll.promise] });
  assert.equal(page.box()?.querySelector(".scan-progress-solo")?.textContent, "Getting ready…", "shown from the first load, before any poll answers");
  assert.equal(page.box()?.querySelector(".scan-progress-head strong")?.textContent, "Scanning Plex and providers");
  assert.deepEqual(page.lines(), []);

  nextPoll.resolve(running({ processed: 0, total: 188, currentPhase: "plex-inventory", activeShows: active(["Bluey", "plex-inventory"]) }));
  await page.advance();
  assert.equal(page.box()?.querySelector(".scan-progress-solo"), null);
  assert.equal(page.box()?.querySelector(".scan-progress-head strong")?.textContent, "Now checking");
  assert.deepEqual(page.lines(), [["Bluey", "Reading episodes in Plex"]]);
});

test("a Plex scan between shows, past getting ready, does not say it is getting ready", async (t) => {
  const page = await mountPage(t, "plex", { statuses: [running({ currentPhase: "processing" })] });
  assert.ok(page.box());
  assert.equal(page.box()?.querySelector(".scan-progress-solo"), null);
});

// A Plex scan's preparation: library records read and shows' episode lists
// prepared, each as "N/M", in place of "Getting ready…" and alongside the shows.

const preparation = (inventory: [number, number], catalogues: [number, number]) => ({
  inventory: { settled: inventory[0], total: inventory[1] },
  catalogues: { settled: catalogues[0], total: catalogues[1] },
});
const preparationLines = (page: { box(): Element | null }) => Array.from(page.box()?.querySelectorAll(".scan-progress-preparation li") || []).map((line) => line.textContent);

test("a preparing Plex scan shows both preparation lines, then the counter once comparisons begin, until preparation finishes", async (t) => {
  const page = await mountPage(t, "plex", { statuses: [running({ processed: 0, total: 0, currentPhase: "initializing", preparation: preparation([210, 666], [140, 653]), activeShows: active(["Bluey", "tmdb-show-and-seasons"]) })] });
  assert.deepEqual(preparationLines(page), ["Reading Plex library 210/666", "Preparing TMDB and TVDB episode lists 140/653"]);
  assert.equal(page.box()?.querySelector(".scan-progress-solo"), null, "not getting ready any more");
  assert.deepEqual(page.lines(), [["Bluey", "Getting the episode list from TMDB"]], "a show prepared early keeps its line");
  assert.match(page.container.querySelector("button.primary")?.textContent || "", new RegExp(`^${PLEX_SCAN_PREPARING_BUTTON_LABEL}`), "no comparison counter before comparisons begin");

  page.nextStatuses(running({ processed: 0, total: 653, preparation: preparation([666, 666], [300, 653]) }));
  await page.advance();
  assert.deepEqual(preparationLines(page), ["Preparing TMDB and TVDB episode lists 300/653"], "the library line goes once the whole library is read");
  assert.match(page.container.querySelector("button.primary")?.textContent || "", /^Checking 0 of 653/, "the counter starts alongside the preparation line");

  page.nextStatuses(running({ processed: 12, total: 653, preparation: preparation([666, 666], [653, 653]), activeShows: active(["Bluey", "episode-crosswalk"]) }));
  await page.advance();
  assert.deepEqual(preparationLines(page), [], "the preparation line goes once preparation finishes");
  assert.deepEqual(page.lines(), [["Bluey", "Matching episode numbers between providers"]]);
});

test("a Plex scan with no shows to compare says so once its library is read, until it completes", async (t) => {
  await t.test("an empty library", async (t) => {
    const page = await mountPage(t, "plex", { statuses: [running({ processed: 0, total: 0, currentPhase: "initializing", preparation: preparation([0, 0], [0, 0]) })] });
    assert.deepEqual(preparationLines(page), []);
    assert.equal(page.box()?.querySelector(".scan-progress-solo")?.textContent, SCAN_NO_SHOWS_TO_COMPARE_WORDING, "the box is not left empty");
  });
  await t.test("every show ignored", async (t) => {
    const page = await mountPage(t, "plex", { statuses: [running({ processed: 0, total: 0, currentPhase: "initializing", preparation: preparation([2, 5], [0, 0]) })] });
    assert.deepEqual(preparationLines(page), ["Reading Plex library 2/5"]);
    assert.equal(page.box()?.querySelector(".scan-progress-solo"), null, "the library line says what it is doing");
    page.nextStatuses(running({ processed: 0, total: 0, currentPhase: "processing", preparation: preparation([5, 5], [0, 0]) }));
    await page.advance();
    assert.deepEqual(preparationLines(page), []);
    assert.equal(page.box()?.querySelector(".scan-progress-solo")?.textContent, SCAN_NO_SHOWS_TO_COMPARE_WORDING);
  });
});

test("malformed Plex preparation progress is ignored", async (t) => {
  const page = await mountPage(t, "plex", { statuses: [running({ processed: 0, total: 0, currentPhase: "initializing", preparation: { inventory: { settled: "x", total: 3 }, catalogues: null } })] });
  assert.deepEqual(preparationLines(page), []);
  assert.equal(page.box()?.querySelector(".scan-progress-solo")?.textContent, "Getting ready…");
});

test("a rate-limit pause during Plex preparation shows the pause notice, with the preparation lines kept and dimmed", async (t) => {
  const view = await mountPaused(t, "plex", paused("TMDB", undefined, { processed: 0, total: 0, activeShows: [], preparation: preparation([666, 666], [140, 653]) }));
  assert.equal(view.notes(), "Paused: TMDB rate limit. Waiting for it to clear.");
  assert.equal(view.heading(), "Waiting");
  assert.equal(view.box()?.getAttribute("data-paused"), "true", "the box is marked paused, which dims its preparation lines");
  assert.deepEqual(preparationLines(view), ["Preparing TMDB and TVDB episode lists 140/653"]);
});

test("the Plex preparation lines go away when the scan completes or fails", async (t) => {
  await t.test("completes", async (t) => {
    const page = await mountPage(t, "plex", { statuses: [running({ processed: 0, total: 0, preparation: preparation([3, 666], [0, 653]) })] });
    assert.equal(preparationLines(page).length, 2);
    page.nextStatuses({ status: "completed", processed: 653, total: 653 });
    await page.advance();
    assert.equal(page.box(), null);
  });
  await t.test("fails", async (t) => {
    const page = await mountPage(t, "plex", { statuses: [running({ processed: 0, total: 0, preparation: preparation([3, 666], [0, 653]) })] });
    page.nextStatuses({ status: "error", processed: 0, total: 0, error: "Plex is unreachable." });
    await page.advance();
    assert.equal(page.box(), null);
  });
});

test("a Plex scan removing unused Manual Match members after its report says so", async (t) => {
  const page = await mountPage(t, "plex", { statuses: [running({ processed: 653, total: 653, currentPhase: "manual-match-removal" })] });
  assert.equal(page.box()?.querySelector(".scan-progress-solo")?.textContent, "Removing unused Manual Match members…");
});

test("the Plex box goes away when the scan completes or fails", async (t) => {
  await t.test("completes", async (t) => {
    const page = await mountPage(t, "plex", { statuses: [running({ activeShows: active(["Bluey", "plex-inventory"]) })] });
    assert.ok(page.box());
    page.nextStatuses({ status: "completed", processed: 188, total: 188 });
    await page.advance();
    assert.equal(page.box(), null);
  });
  await t.test("fails", async (t) => {
    const page = await mountPage(t, "plex", { statuses: [running({ activeShows: active(["Bluey", "plex-inventory"]) })] });
    page.nextStatuses({ status: "error", processed: 41, total: 188, error: "Plex is unreachable." });
    await page.advance();
    assert.equal(page.box(), null);
    assert.match(page.container.querySelector(".error")?.textContent || "", /Plex is unreachable\./);
  });
});

// A rate-limit pause: the box names the provider, with the resume time and a
// countdown that ticks on its own while the next status answer is held pending.

const at = (seconds: number) => new Date(START.getTime() + seconds * 1000).toISOString();
const PAGES = [
  { page: "trakt", provider: "Trakt", radar: "PAUSED - RATE LIMIT", button: /^Paused due to Rate Limit/ },
  { page: "plex", provider: "TMDB", radar: "PAUSED · TMDB", button: /^Paused for TMDB rate limit/ },
] as const;
for (const { page, provider, radar, button } of PAGES) {
  test(`a paused ${page} scan names the provider and counts down to the resume time between status answers`, async (t) => {
    const view = await mountPaused(t, page, paused(provider, at(250)));
    assert.equal(view.box()?.getAttribute("data-paused"), "true", "the box is marked paused, which dims its show lines");
    assert.equal(view.heading(), "Waiting");
    assert.match(view.notes() || "", new RegExp(`^Paused: ${provider} rate limit\\. Resumes at \\d{2}:\\d{2}\\.$`));
    assert.equal(view.countdown(), "4m 10s");
    assert.deepEqual(view.lines().map(([show]) => show), ["Severance", "Bluey"], "the show lines stay, dimmed");
    assert.equal(view.radar(), radar, "the radar is unchanged");
    assert.match(view.button(), button, "the scan button is unchanged");

    await view.advance();
    assert.equal(view.countdown(), "4m 9s", "the countdown ticks while the next status answer is pending");
    await view.advance(3);
    assert.equal(view.countdown(), "4m 6s");
  });

  test(`a paused ${page} scan without a known end says it is waiting for the limit to clear`, async (t) => {
    const view = await mountPaused(t, page, paused(provider, undefined));
    assert.equal(view.notes(), `Paused: ${provider} rate limit. Waiting for it to clear.`);
    assert.equal(view.countdown(), null, "no made-up time");
    assert.equal(view.heading(), "Waiting");
  });

  test(`a ${page} pause with a new provider or deadline replaces the old one`, async (t) => {
    const view = await mountPaused(t, page, paused(provider, at(250)));
    view.nextPoll.resolve(paused("TVDB", at(91)));
    await view.advance();
    assert.match(view.notes() || "", /^Paused: TVDB rate limit\. Resumes at \d{2}:\d{2}\.$/);
    assert.equal(view.countdown(), "1m 30s");
    view.nextStatuses(paused("TVDB", undefined));
    await view.advance();
    assert.equal(view.notes(), "Paused: TVDB rate limit. Waiting for it to clear.");
    assert.equal(view.countdown(), null);
  });

  test(`a ${page} countdown stops at zero and the box stays paused until a status clears the pause`, async (t) => {
    const view = await mountPaused(t, page, paused(provider, at(2)));
    assert.equal(view.countdown(), "2s");
    await view.advance(4);
    assert.equal(view.countdown(), "0s");
    assert.equal(view.box()?.getAttribute("data-paused"), "true");
    assert.equal(view.heading(), "Waiting");

    view.nextPoll.resolve(running({ activeShows: active(["Severance", "poster"]) }));
    await view.advance();
    assert.equal(view.notice(), null, "the notice goes away");
    assert.equal(view.box()?.hasAttribute("data-paused"), false, "the show lines return to normal");
    assert.equal(view.heading(), "Now checking");
    assert.deepEqual(view.lines(), [["Severance", "Fetching the poster"]]);
  });

  test(`a paused ${page} box goes away when the scan completes or fails`, async (t) => {
    await t.test("completes", async (t) => {
      const view = await mountPaused(t, page, paused(provider, at(250)));
      view.nextPoll.resolve({ status: "completed", processed: 312, total: 312 });
      await view.advance();
      assert.equal(view.box(), null);
    });
    await t.test("fails", async (t) => {
      const view = await mountPaused(t, page, paused(provider, at(250)));
      view.nextPoll.resolve({ status: "error", processed: 41, total: 312, error: "The scan failed." });
      await view.advance();
      assert.equal(view.box(), null);
    });
  });

  test(`a ${page} countdown stops its timer when the page closes`, async (t) => {
    const view = await mountPaused(t, page, paused(provider, at(250)));
    const nextTick = Date.now() + 1000;
    assert.ok(view.clock.pending().includes(nextTick), "the countdown waits for its next second");
    await view.unmount();
    assert.ok(!view.clock.pending().includes(nextTick), "the countdown's timer is cleared");
  });

  test(`an older ${page} status paused with no provider, end or shows still shows the notice`, async (t) => {
    const view = await mountPaused(t, page, { status: "running", processed: 3, total: 12, rateLimitPaused: true });
    assert.equal(view.notes(), "Paused: rate limit. Waiting for it to clear.");
    assert.deepEqual(view.lines(), []);
    assert.equal(view.heading(), "Waiting");
  });
}

for (const { page, start } of [{ page: "trakt", start: "Quick scan" }, { page: "plex", start: "New Plex search" }] as const) {
  test(`a new ${page} scan does not show the shows or pause of a run whose polling failed`, async (t) => {
    const view = await mountPage(t, page, page === "trakt"
      ? { stateScan: paused("Trakt", undefined), statuses: [new TypeError("network down")] }
      : { statuses: [paused("TMDB", undefined), new TypeError("network down")] });
    await view.advance();
    assert.equal(view.box(), null, "polling ended");

    const firstPoll = pending();
    view.nextStatuses(firstPoll.promise);
    const button = Array.from(view.container.querySelectorAll("button")).find((item) => item.textContent?.includes(start));
    assert.ok(button, `${start} is shown`);
    await act(async () => { button.click(); });
    await view.advance();
    assert.equal(view.server.starts, 1);
    assert.ok(view.box(), "the new scan's box shows while its first poll is pending");
    assert.deepEqual(view.lines(), [], "no show lines from the failed run");
    assert.equal(view.box()?.hasAttribute("data-paused"), false, "no pause from the failed run");
  });
}
