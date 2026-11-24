import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { api, harness, type Episode } from "./report-missing-harness";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const config = await import("../lib/server-config");
hook.deregister();

// ADR-0007 through the Plex scan workflow: a TVDB episode a Healthy Manual Match covers
// leaves the IMDb, Trakt and TMDB episode crosswalk candidates, so a live scan spends no
// provider request on it. The Manual Match health recheck still runs every scan and asks
// TVDB for each TVDB member's extended episode, the same endpoint as the IMDb crosswalk,
// so requests are told apart by when they are made: the health recheck runs before the
// scan reads Plex's library sections.

// TMDB numbers the season S1; TVDB numbers the same episodes S2, so each TVDB episode
// reaches the crosswalks. Plex owns both TMDB episodes, and also reports an IMDb ID no
// TVDB episode carries, so every uncovered TVDB episode is looked up through IMDb, then
// Trakt (which finds nothing), then the TMDB external-ID crosswalk.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const connectTrakt = () => config.writeTraktCredentials({ clientId: "client", clientSecret: "secret", accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });

type Outcome = { provider: string; id: number; status: string };
type Show = { ratingKey: string; missing: { tvdbEpisodeId?: number; sources: string[] }[]; autoMatches?: { tvdb: { id?: number } }[]; coverageOutcomes?: Outcome[] };
type Result = { report: { shows: Show[] } };
const target = (result: unknown) => (result as Result).report.shows.find(show => show.ratingKey === "ratingKey:target")!;
/** TVDB episodes of Target credited to a Manual Match. */
const manual = (result: unknown) => (target(result).coverageOutcomes || []).filter(outcome => outcome.status === "manual" && outcome.provider === "TVDB").map(outcome => outcome.id).sort();

/** IMDb, Trakt and TMDB crosswalk requests a live scan made for one TVDB episode. */
const crosswalkWork = (scanRequests: string[], tvdbEpisodeId: number) => scanRequests.filter(path => [`/v4/episodes/${tvdbEpisodeId}/extended`, `/search/tvdb/${tvdbEpisodeId}`, `/3/find/${tvdbEpisodeId}`].includes(path));
const allCrosswalks = (tvdbEpisodeId: number) => [`/v4/episodes/${tvdbEpisodeId}/extended`, `/search/tvdb/${tvdbEpisodeId}`, `/3/find/${tvdbEpisodeId}`];

async function setup(t: test.TestContext, catalogue: Episode[] = [tmdb1, tmdb2, tvdb1, tvdb2], owned: Episode[] = [tmdb1, tmdb2]) {
  const h = await harness(t, catalogue, owned);
  await connectTrakt();
  h.state.imdb.set(tmdb2.id, "tt0000002");
  /** Runs a live scan; splits its requests into the health recheck's and the scan's own. */
  const scan = async (ratingKey?: string) => {
    h.requests.length = 0;
    const result = await h.rerun(ratingKey);
    const sections = h.requests.indexOf("/library/sections");
    assert.ok(sections >= 0, "the scan read Plex's library sections");
    return { result, health: h.requests.slice(0, sections), scanned: h.requests.slice(sections) };
  };
  const saveMatch = async (members: Episode[]) => {
    const saved = await h.save(members);
    assert.equal(saved.status, 201, await saved.clone().text());
    return (await saved.json()).mapping as { id: string; revision: number };
  };
  return { ...h, owned, scan, saveMatch };
}

test("a live scan makes the health recheck's requests but no IMDb, Trakt or TMDB crosswalk request for a TVDB episode a Manual Match covers", async t => {
  const h = await setup(t);
  await h.saveMatch([tmdb1, tvdb1]);
  const { result, health, scanned } = await h.scan();

  assert.ok(health.includes("/v4/episodes/301/extended"), "the health recheck verifies the TVDB member");
  assert.ok(health.includes("/3/tv/10/season/1/episode/1"), "the health recheck verifies the TMDB member's coordinates");
  assert.deepEqual(crosswalkWork(scanned, 301), [], "the covered TVDB episode gets no crosswalk work");
  assert.deepEqual(crosswalkWork(scanned, 302).sort(), allCrosswalks(302).sort(), "an uncovered TVDB episode is looked up through IMDb, Trakt and TMDB");
  assert.deepEqual(manual(result), [301]);
});

// Losing coverage restores normal crosswalk work against current evidence. Each change is
// made after a scan in which the Manual Match covered TVDB 301, so TVDB 301 has no saved
// crosswalk answer and the next scan must look it up.
const losses: { change: string; lose: (h: Awaited<ReturnType<typeof setup>>, mapping: { id: string; revision: number }) => Promise<void>; covered: number[] }[] = [
  { change: "the Manual Match is deleted", covered: [], lose: async (_h, mapping) => {
    const deleted = await api.DELETE(new Request(`http://localhost/api/plex/manual-coverage?id=${encodeURIComponent(mapping.id)}`, { method: "DELETE" }));
    assert.equal(deleted.status, 200, await deleted.clone().text());
  } },
  { change: "the Manual Match is edited to cover TVDB 302 instead", covered: [302], lose: async (h, mapping) => {
    const resolved = await h.post({ action: "resolve", id: mapping.id, urls: [`tmdb:${tmdb2.id} show:10 season:${tmdb2.season} episode:${tmdb2.episode}`, `tvdb:${tvdb2.id}`] });
    assert.equal(resolved.status, 200, await resolved.clone().text());
    const edited = await h.post({ action: "save", id: mapping.id, revision: mapping.revision, preview: (await resolved.json()).preview });
    assert.equal(edited.status, 200, await edited.clone().text());
  } },
  { change: "Plex no longer owns the other side directly", covered: [], lose: async h => { h.owned.splice(h.owned.indexOf(tmdb1), 1); } },
  { change: "the Manual Match becomes Pending", covered: [], lose: async h => { h.state.statuses.set("/3/tv/10/season/1/episode/1", 404); } },
  { change: "the Manual Match becomes Needs review", covered: [], lose: async h => { h.state.statuses.set("/v4/episodes/301/extended", 404); } },
];
for (const { change, lose, covered } of losses) test(`normal crosswalk work resumes for TVDB 301 when ${change}`, async t => {
  const h = await setup(t);
  const mapping = await h.saveMatch([tmdb1, tvdb1]);
  const before = await h.scan();
  assert.deepEqual(crosswalkWork(before.scanned, 301), []);
  assert.deepEqual(manual(before.result), [301]);

  await lose(h, mapping);
  const after = await h.scan();
  assert.deepEqual(crosswalkWork(after.scanned, 301).sort(), allCrosswalks(301).sort(), "TVDB 301 is looked up through IMDb, Trakt and TMDB again");
  assert.deepEqual(manual(after.result), covered);
  for (const id of covered) assert.deepEqual(crosswalkWork(after.scanned, id), [], `TVDB ${id}, now covered, gets no crosswalk work`);
  assert.ok(target(after.result).missing.some(episode => episode.tvdbEpisodeId === 301), "with no owned TMDB match, TVDB 301 is missing against current evidence");
});

test("a single-show scan and a cross-show Manual Match whose source is in an ignored show skip the covered episode's crosswalks too", async t => {
  // TMDB 9101 belongs to "Other", which is ignored; Plex owns it there.
  const tmdbOther: Episode = { provider: "TMDB", id: 9101, season: 1, episode: 1, name: "Pilot", show: "other" };
  const h = await setup(t, [tmdb1, tmdb2, tmdbOther, tvdb1, tvdb2], [tmdb1, tmdb2, tmdbOther]);
  const ignored = await h.patchSettings({ ignoredShows: [{ ratingKey: "ratingKey:other", title: "Other", duration: "forever" }] });
  assert.equal(ignored.status, 200, await ignored.clone().text());
  await h.saveMatch([tmdbOther, tvdb1]);

  for (const ratingKey of [undefined, "ratingKey:target"]) {
    const { result, health, scanned } = await h.scan(ratingKey);
    const scope = ratingKey ? "single-show scan" : "full scan";
    assert.ok(health.includes("/v4/episodes/301/extended"), `${scope}: the health recheck still runs`);
    assert.deepEqual(crosswalkWork(scanned, 301), [], `${scope}: the covered TVDB episode gets no crosswalk work`);
    assert.ok(crosswalkWork(scanned, 302).includes("/3/find/302"), `${scope}: uncovered episodes keep their crosswalks`);
    assert.deepEqual(manual(result), [301], `${scope}: the cross-show Manual Match covers TVDB 301`);
  }
});

// Shared crosswalk evidence: "Target" and "Other" both list TVDB 301 at coordinates neither
// owns, so both comparisons need the same TMDB external-ID crosswalk. A Manual Match covers
// TVDB 301 wherever it is listed, so it is covered in Target alone by a single-show scan of
// Target while the match exists; Other is not compared again until the match is deleted.
const tvdb1InOther: Episode = { ...tvdb1, show: "other" };
const tmdbOther: Episode = { provider: "TMDB", id: 9101, season: 1, episode: 1, name: "Pilot", show: "other" };
const found = (episode: Episode) => ({ tv_episode_results: [{ id: episode.id, show_id: 10, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });
const autoMatched = (result: unknown, name: "target" | "other") => ((result as Result).report.shows.find(show => show.ratingKey === `ratingKey:${name}`)!.autoMatches || []).map(match => match.tvdb.id);
const missing301 = (result: unknown, name: "target" | "other") => (result as Result).report.shows.find(show => show.ratingKey === `ratingKey:${name}`)!.missing.some(episode => episode.tvdbEpisodeId === 301);
const issueIds = (result: unknown) => (result as { coverage: { issues: { id: string }[] } }).coverage.issues.map(issue => issue.id);
const settled = async (status: () => Promise<unknown>) => {
  let result = await status();
  for (let i = 0; i < 100 && (result as { coverage: { pending?: unknown } }).coverage.pending; i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await status(); }
  return result;
};

for (const answer of ["a valid answer", "a rejection"] as const) test(`covering a shared crosswalk's episode in one show leaves the other show ${answer}, across restart`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T10:00:00Z") });
  const h = await harness(t, [tmdb1, tmdbOther, tvdb1, tvdb1InOther], [tmdb1, tmdbOther]);
  h.state.bodies.set("/3/find/301", found(tmdb1));
  const first = await h.rerun();
  for (const name of ["target", "other"] as const) assert.deepEqual(autoMatched(first, name), [301], `${name}: the shared answer covers TVDB 301`);
  if (answer === "a rejection") {
    // Other's rescan fails, which rejects the shared answer for every show.
    h.state.statuses.set("/3/find/301", 404);
    t.mock.timers.setTime(Date.parse("2026-11-12T11:00:00Z"));
    assert.equal(missing301(await h.rerun("ratingKey:other"), "other"), true);
    h.state.statuses.delete("/3/find/301");
  }

  const saved = await h.save([tmdb1, tvdb1]);
  assert.equal(saved.status, 201, await saved.clone().text());
  const mapping = (await saved.json()).mapping as { id: string };
  await settled(h.status);
  t.mock.timers.setTime(Date.parse("2026-11-12T12:00:00Z"));
  h.requests.length = 0;
  const covered = await h.rerun("ratingKey:target");
  assert.deepEqual(h.requests.filter(path => path === "/3/find/301"), [], "the covered show spends no request on the crosswalk, even in a single-show scan that forces its lookups");
  assert.deepEqual(manual(covered), [301]);

  h.restart();
  h.requests.length = 0;
  const deleted = await api.DELETE(new Request(`http://localhost/api/plex/manual-coverage?id=${encodeURIComponent(mapping.id)}`, { method: "DELETE" }));
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const uncovered = await settled(h.status);
  assert.deepEqual([...h.requests], [], "the cached recheck stays offline");
  if (answer === "a valid answer") {
    assert.deepEqual(autoMatched(uncovered, "other"), [301], "Other keeps its valid answer");
    // Target's covered scan saved no crosswalk copy for TVDB 301, so offline it has no evidence
    // for TVDB 301 and asks for a live scan, under the evidence layer's normal rules.
    assert.deepEqual(autoMatched(uncovered, "target"), []);
    assert.equal(missing301(uncovered, "target"), true);
    assert.deepEqual(issueIds(uncovered), ["episode-check:ratingKey:target:episode-crosswalk:TMDB:TVDB:301"]);
    t.mock.timers.setTime(Date.parse("2026-11-12T13:00:00Z"));
    h.requests.length = 0;
    const resumed = await h.rerun();
    assert.deepEqual(h.requests.filter(path => path === "/3/find/301"), ["/3/find/301"], "Target's retry is one request, shared with Other");
    for (const name of ["target", "other"] as const) assert.deepEqual(autoMatched(resumed, name), [301]);
    assert.deepEqual(issueIds(resumed), []);
  } else {
    for (const name of ["target", "other"] as const) {
      assert.deepEqual(autoMatched(uncovered, name), [], `${name}: no older copy of the rejected answer is revived`);
      assert.equal(missing301(uncovered, name), true);
    }
    t.mock.timers.setTime(Date.parse("2026-11-12T13:00:00Z"));
    h.requests.length = 0;
    const retried = await h.rerun();
    assert.deepEqual(h.requests.filter(path => path === "/3/find/301"), ["/3/find/301"], "the rejected answer is retried once for both shows");
    for (const name of ["target", "other"] as const) assert.deepEqual(autoMatched(retried, name), [301]);
  }
});
