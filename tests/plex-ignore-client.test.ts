import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import PlexPage from "../app/plex/page";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const report = {
  shows: [{ ratingKey: "one", title: "Example Show", plexEpisodes: 1, missing: [{ season: 1, episode: 2, sources: ["TMDB"] }] }],
  lastScan: "2026-11-06T12:00:00.000Z",
  scanCache: { one: { fingerprint: "example" } },
};
const completed = { scan: { status: "completed", processed: 1, total: 1 }, report };
const json = (body: unknown) => Response.json(body);

async function mountPage(t: test.TestContext, fetcher: typeof fetch, strictMode = false) {
  const browser = new Window({ url: "http://localhost:3000/plex" });
  const globals = {
    window: browser,
    self: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: fetcher,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => { root.unmount(); });
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => { root.render(strictMode ? createElement(StrictMode, null, createElement(PlexPage)) : createElement(PlexPage)); });
  async function click(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find((element) => (element.getAttribute("aria-label") || element.textContent || "").includes(label));
    assert.ok(button, `Expected button: ${label}`);
    await act(async () => { button.click(); });
  }
  return { container, click };
}

function configuredFetch(scanFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (input === "/api/plex/config") return json({ configured: true, plexUrl: "http://plex.example.test" });
    if (input === "/api/plex/state") return json({ settings: { ignoredShows: [], ignoredSeasons: [] } });
    if (input === "/api/plex/scan") return scanFetch(input, init);
    throw new Error(`Unexpected request: ${String(input)}`);
  };
}

test("Plex Restore keeps ignored results removed after a delayed scan response until a new scan", async (t) => {
  const startScan = deferred<Response>();
  const pendingReport = deferred<Response>();
  let scanning = false;
  let freshScan = false;
  const { container, click } = await mountPage(t, configuredFetch(async (_input, init) => {
    if (init?.method === "POST") {
      if (freshScan) return json({});
      scanning = true;
      return startScan.promise;
    }
    return scanning && !freshScan ? pendingReport.promise : json(completed);
  }));
  assert.equal(container.querySelectorAll(".show-list article").length, 1);

  // The scan POST is pending, so Ignore is still available on the saved report.
  await click("New Plex search");
  await click("Example Show");
  await click("Ignore this show");
  await click("Forever");
  await act(async () => { startScan.resolve(json({})); });
  // This response carries results serialized before the ignore was persisted.
  await act(async () => { pendingReport.resolve(json(completed)); });
  await click("IGNORED SHOWS");
  await click("Restore Example Show");
  await click("Close ignored shows");

  assert.equal(container.querySelectorAll(".show-list article").length, 0, "Restore must not reveal results from before Ignore");
  await click("Plex preferences");
  assert.match(container.textContent || "", /Cached results for 0 shows/);
  await click("Close");

  freshScan = true;
  await click("New Plex search");
  assert.equal(container.querySelector(".show-name-button")?.textContent, "Example Show", "a scan started after Restore can return fresh results");
  await click("Plex preferences");
  assert.match(container.textContent || "", /Cached results for 1 show/);
});

test("Plex keeps a fresh post-Restore scan when the initial report request arrives late", async (t) => {
  const initialReport = deferred<Response>();
  let firstLoad = true;
  let freshScan = false;
  const freshReport = { ...report, shows: [{ ...report.shows[0], missing: [{ season: 1, episode: 3, sources: ["TMDB"] }] }] };
  const { container, click } = await mountPage(t, configuredFetch(async (_input, init) => {
    if (init?.method === "POST") return json({});
    if (firstLoad) { firstLoad = false; return initialReport.promise; }
    return json(freshScan ? { ...completed, report: freshReport } : completed);
  }));
  await click("New Plex search");
  await click("Example Show");
  await click("Ignore this show");
  await click("Forever");
  await click("IGNORED SHOWS");
  await click("Restore Example Show");
  await click("Close ignored shows");
  freshScan = true;
  await click("New Plex search");
  await act(async () => { initialReport.resolve(json(completed)); });

  assert.equal(container.querySelector(".episode-code-tile span")?.textContent, "S01E03", "a report from an older request must not replace a fresh scan");
});

test("Plex Restore cannot expose a report that arrived before saved whole-show ignores", async (t) => {
  const settings = deferred<Response>();
  const fallback = configuredFetch(async () => json(completed));
  const { container, click } = await mountPage(t, async (input, init) => input === "/api/plex/state" && !init?.method ? settings.promise : fallback(input, init));
  assert.equal(container.querySelectorAll(".show-list article").length, 1);
  await act(async () => { settings.resolve(json({ settings: { ignoredShows: [{ ratingKey: "one", title: "Example Show" }] } })); });
  await click("IGNORED SHOWS");
  await click("Restore Example Show");
  await click("Close ignored shows");

  assert.equal(container.querySelectorAll(".show-list article").length, 0);
  await click("Plex preferences");
  assert.match(container.textContent || "", /Cached results for 0 shows/);
});

test("Plex expiry keeps delayed whole-show results removed until a new scan", async (t) => {
  const startScan = deferred<Response>();
  const pendingReport = deferred<Response>();
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  let scanning = false;
  let freshScan = false;
  const { container, click } = await mountPage(t, configuredFetch(async (_input, init) => {
    if (init?.method === "POST") {
      if (freshScan) return json({});
      scanning = true;
      return startScan.promise;
    }
    return scanning && !freshScan ? pendingReport.promise : json(completed);
  }));
  await click("New Plex search");
  await click("Example Show");
  await click("Ignore this show");
  await click("30 days");
  await act(async () => { startScan.resolve(json({})); });
  await act(async () => { pendingReport.resolve(json(completed)); });
  t.mock.method(Date, "now", () => now + 31 * 86_400_000);
  await act(async () => { window.dispatchEvent(new window.Event("focus")); });
  await click("IGNORED SHOWS");

  assert.match(container.textContent || "", /No shows are ignored/);
  await click("Close ignored shows");
  assert.equal(container.querySelectorAll(".show-list article").length, 0, "expiry must not reveal delayed results from before Ignore");
  freshScan = true;
  await click("New Plex search");
  assert.equal(container.querySelector(".show-name-button")?.textContent, "Example Show");
});

test("Plex ignores an aborted old poll after Restore and a fresh scan", async (t) => {
  const abortedBody = deferred<typeof completed>();
  const currentPoll = deferred<Response>();
  const startScan = deferred<Response>();
  const pendingReport = deferred<Response>();
  const freshReport = { ...report, shows: [{ ...report.shows[0], missing: [{ season: 1, episode: 3, sources: ["TMDB"] }] }] };
  let scanGets = 0;
  let freshScan = false;
  const { container, click } = await mountPage(t, configuredFetch(async (_input, init) => {
    if (init?.method === "POST") return freshScan ? json({}) : startScan.promise;
    scanGets += 1;
    // StrictMode repeats initial loading. Both running statuses start real polls;
    // the second poll aborts the first while its body is already being parsed.
    if (scanGets <= 2) return json({ ...completed, scan: { status: "running", processed: 0, total: 1 } });
    if (scanGets === 3) return Object.assign(json({}), { json: () => abortedBody.promise });
    if (scanGets === 4) return currentPoll.promise;
    return freshScan ? json({ ...completed, report: freshReport }) : pendingReport.promise;
  }), true);
  await act(async () => { currentPoll.resolve(json(completed)); });
  await click("New Plex search");
  await click("Example Show");
  await click("Ignore this show");
  await click("Forever");
  await act(async () => { startScan.resolve(json({})); });
  await act(async () => { pendingReport.resolve(json(completed)); });
  await click("IGNORED SHOWS");
  await click("Restore Example Show");
  await click("Close ignored shows");
  assert.equal(container.querySelectorAll(".show-list article").length, 0);
  freshScan = true;
  await click("New Plex search");
  await act(async () => { abortedBody.resolve(completed); });

  assert.equal(container.querySelector(".episode-code-tile span")?.textContent, "S01E03", "an aborted older poll must not replace the post-Restore scan");
});

test("manual mapping deletion cannot be overwritten by an older initial Plex report response", async (t) => {
  const initialReport = deferred<Response>();
  let scanReads = 0;
  let saved = true;
  const fresh = { ...report, shows: report.shows.map(show => ({ ...show, title: "Fresh coverage revision" })) };
  const defaults = configuredFetch(async () => {
    if (++scanReads === 1) return initialReport.promise;
    return json({ scan: completed.scan, report: fresh, coverage: { revision: 2, pending: 0 } });
  });
  const { container, click } = await mountPage(t, async (input, init) => {
    if (String(input).startsWith("/api/plex/manual-coverage")) {
      if (init?.method === "DELETE") {
        saved = false;
        return json({ deleted: ["saved"], revision: 2, pending: 1 });
      }
      return json({ revision: saved ? 1 : 2, pending: 0, mappings: saved ? [{ id: "saved", revision: 1, members: [] }] : [] });
    }
    return defaults(input, init);
  });
  await click("Manual Coverage");
  await click("Delete mapping");
  await act(async () => { initialReport.resolve(json({ ...completed, coverage: { revision: 1, pending: 0 } })); });
  await click("Close manual coverage");
  assert.equal(container.querySelector(".show-name-button")?.textContent, "Fresh coverage revision");
});


test("incomplete coverage displays one identity-preserving group and opens its saved mapping", async (t) => {
  const members = [
    {provider:"TMDB",id:100,showId:10,show:"Combined show",title:"Complete special",season:1,episode:1,url:"https://www.themoviedb.org/tv/10/season/1/episode/1",status:"missing"},
    {provider:"TVDB",id:200,showId:20,show:"Parts show",title:"Part one",season:1,episode:1,url:"https://thetvdb.com/series/parts/episodes/200",status:"direct"},
    {provider:"TVDB",id:201,showId:21,show:"Other parts show",title:"Part two",season:1,episode:1,url:"https://thetvdb.com/series/other-parts/episodes/201",status:"missing"},
    {provider:"TVDB",id:202,showId:21,show:"Other parts show",title:"Automatically matched",season:1,episode:2,url:"https://thetvdb.com/series/other-parts/episodes/202",status:"automatic"},
  ];
  const groupedReport = {...report,shows:[{...report.shows[0],missing:[{season:1,episode:1,airDate:"2020-01-01",tmdbEpisodeId:100,tvdbEpisodeId:999,sources:["TMDB","TVDB"]}]},{ratingKey:"two",title:"Separate Plex comparison",plexEpisodes:1,missing:[{season:1,episode:1,airDate:"2020-01-01",tvdbEpisodeId:201,sources:["TVDB"]}]}],coverageGroups:[{mappingId:"group",members,missing:[{provider:"TMDB",id:100,status:"missing",season:1,airDate:"2020-01-01",showKey:"one"},{provider:"TVDB",id:201,status:"missing",season:1,airDate:"2020-01-01",showKey:"two"}]}]};
  const defaults=configuredFetch(async()=>json({...completed,report:groupedReport}));
  const {container,click}=await mountPage(t,async(input,init)=>String(input).startsWith("/api/plex/manual-coverage") ? json({revision:1,mappings:[{id:"group",revision:1,members}],pending:0}) : defaults(input,init));
  const group=container.querySelector('[aria-label="Incomplete coverage group"]');
  assert.ok(group);
  assert.equal(container.querySelectorAll('[aria-label="Incomplete coverage group"]').length,1);
  assert.match(group.textContent||"",/Directly owned/);
  assert.match(group.textContent||"",/Satisfied automatically/);
  assert.match(group.textContent||"",/Part two/);
  assert.match(group.textContent||"",/Alternative complete TMDB set/);
  assert.match(group.textContent||"",/Alternative complete TVDB set/);
  assert.deepEqual([...group.querySelectorAll('a')].map(a=>a.getAttribute('href')),members.map(m=>m.url));
  assert.equal(container.querySelectorAll('.plex-episode-item').length,1,"the ungrouped provider at the same coordinates keeps its tile");
  assert.equal(container.querySelectorAll('.show-list article').length,2,"Plex show comparisons remain separate");
  await click("Edit coverage mapping");
  assert.match(container.querySelector('[role="dialog"]')?.textContent||"",/Editing mapping group/);
});


test("coverage groups respect aired-date and season-ignore visibility", async (t) => {
  for (const settings of [{hideUnairedEpisodes:true}, {ignoredSeasons:[{ratingKey:"one",title:"Example Show",seasons:[1]}]}]) {
    await t.test(JSON.stringify(settings),async subtest=>{
      const groupedReport={...report,shows:[{...report.shows[0],missing:[{season:1,episode:1,airDate:"2099-01-01",tmdbEpisodeId:100,sources:["TMDB"]}]}],coverageGroups:[{mappingId:"hidden",members:[],missing:[{provider:"TMDB",id:100,status:"missing",season:1,airDate:"2099-01-01",showKey:"one"}]}]};
      const defaults=configuredFetch(async()=>json({...completed,report:groupedReport}));
      const {container}=await mountPage(subtest,async(input,init)=>input==="/api/plex/state" ? json({settings}) : defaults(input,init));
      assert.equal(container.querySelector('[aria-label="Incomplete coverage group"]'),null);
    });
  }
});
