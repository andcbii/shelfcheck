import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { flag, harness, key, type Episode } from "./report-missing-harness";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const changes = await import("../lib/manual-match-changes");
const store = await import("../lib/manual-coverage");
const catalogues = await import("../lib/plex-catalogues");
const { plexSavedState, readPlexPreferences } = await import("../lib/plex-scan");
const { scanRuns } = await import("../lib/scan-run");
hook.deregister();

// The Manual Match change module's Ignore command: clear Report Missing flags
// for newly applied Ignore scopes, with the Ignore save inside the same
// transaction. Real SQLite store and real offline (cached) recheck queue, with
// mocked Plex and provider HTTP. Target is TMDB 10 / TVDB 20 and Plex owns none
// of it; Other is TMDB 11 / TVDB 21 and Plex owns only its season 3 episode 5.
const tA: Episode = { provider: "TMDB", id: 101, season: 1, episode: 1, name: "A" };
const vA: Episode = { provider: "TVDB", id: 201, season: 1, episode: 1, name: "A" };
const tB: Episode = { provider: "TMDB", id: 102, season: 2, episode: 1, name: "B" };
const vB: Episode = { provider: "TVDB", id: 202, season: 2, episode: 1, name: "B" };
const oT: Episode = { provider: "TMDB", id: 111, season: 3, episode: 5, name: "Owned", show: "other" };
const oV: Episode = { provider: "TVDB", id: 211, season: 3, episode: 5, name: "Owned", show: "other" };
const xT: Episode = { provider: "TMDB", id: 112, season: 3, episode: 6, name: "Unowned", show: "other" };
const xV: Episode = { provider: "TVDB", id: 212, season: 3, episode: 6, name: "Unowned", show: "other" };

const TARGET = "ratingKey:target", OTHER = "ratingKey:other";
const database = () => (globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync }).__shelfcheckDatabase!;
const forever = (ratingKey: string, title: string) => ({ ratingKey, title, duration: "forever" });

/**
 * A harness after one full Plex scan with three flagged one-to-one Manual
 * Matches: `inTarget` (A), `seasonTwo` (B, Target season 2) and, in Other,
 * `owned` (Plex owns it) and `unowned` (only the provider catalogue lists it).
 */
async function setup(t: test.TestContext) {
  const h = await harness(t, [tA, vA, tB, vB, oT, oV, xT, xV], [oT, oV]);
  const saved = async (members: Episode[]) => {
    const response = await h.save(members, { reportMissing: members.map(flag) });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).mapping as { id: string; revision: number };
  };
  const ids = { inTarget: (await saved([tA, vA])).id, seasonTwo: (await saved([tB, vB])).id, owned: (await saved([oT, oV])).id, unowned: (await saved([xT, xV])).id };
  await h.rerun();
  /** Each Manual Match's flagged members, by name. */
  const flags = async () => Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([name, id]) => [name, await h.flags(id)])));
  /** Counts Ignore save callbacks; `alongside` runs inside each one. */
  const saves = { count: 0 };
  const save = (alongside: () => void = () => {}) => () => { saves.count++; alongside(); };
  const comparison = (ratingKey: string) => catalogues.readPlexInputs().comparisons[ratingKey];
  return { ...h, ids, flags, saves, save, comparison };
}

const flagsOf = (...members: Episode[]) => members.map(key);
const ALL_FLAGGED = { inTarget: flagsOf(tA, vA), seasonTwo: flagsOf(tB, vB), owned: flagsOf(oT, oV), unowned: flagsOf(xT, xV) };

test("an Ignore clears flags of members whose own provider show is the ignored show, never through aliases or mis-tagged Plex items", async (t) => {
  const h = await setup(t);
  // Target's saved comparison lists Other's provider shows as aliases, and one of
  // Target's Plex items carries an identity of Other's owned episode.
  const target = h.comparison(TARGET);
  catalogues.savePlexComparison(TARGET, { ...target, tmdbAliases: [...target.tmdbAliases, 11], tvdbAliases: [...target.tvdbAliases, 21], tmdbEpisodeAliases: [11] });
  const inventory = catalogues.readPlexInputs().inventory!;
  const otherItem = inventory.evidence.find(item => item.showKey === OTHER && item.identities.some(identity => identity.provider === "TMDB" && identity.id === oT.id))!;
  catalogues.savePlexInventory({ ...inventory, evidence: [...inventory.evidence, { ...otherItem, ratingKey: "mis-tagged", showKey: TARGET }] });

  const result = await changes.clearReportMissingForIgnore([{ ratingKey: TARGET }], h.save());
  assert.equal(h.saves.count, 1);
  assert.equal(typeof result.coverageRevision, "number");
  assert.deepEqual(await h.flags(), { ...ALL_FLAGGED, inTarget: [], seasonTwo: [] }, "Only Target's own members lose their flags");

  await changes.clearReportMissingForIgnore([{ ratingKey: OTHER }], h.save());
  assert.deepEqual(await h.flags(), { inTarget: [], seasonTwo: [], owned: [], unowned: [] }, "With a saved comparison, Other's catalogue decides, owned by Plex or not");
});

test("without a saved comparison, an Ignore uses only the show's own Plex items", async (t) => {
  const h = await setup(t);
  database().prepare("DELETE FROM shelfcheck_plex_generated_inputs WHERE cache_key=?").run(`comparison:${OTHER}`);
  const result = await changes.clearReportMissingForIgnore([{ ratingKey: OTHER }], h.save());
  assert.equal(typeof result.coverageRevision, "number");
  assert.deepEqual(await h.flags(), { ...ALL_FLAGGED, owned: [] }, "Plex owns only the `owned` episodes; the unowned flags stay");
});

test("a season Ignore uses the provider catalogue's season, else the member's saved season", async (t) => {
  const h = await setup(t);
  // The TMDB catalogue now places B in season 5; TVDB no longer catalogues A.
  const inputs = catalogues.readPlexInputs();
  const tmdb = inputs.tmdb["10"];
  catalogues.savePlexCatalogue("tmdb", 10, { ...tmdb, episodes: tmdb.episodes.map(episode => episode.providerEpisodeId === tB.id ? { ...episode, season: 5 } : episode) });
  const tvdb = inputs.tvdb["20"];
  catalogues.savePlexCatalogue("tvdb", 20, { ...tvdb, episodes: tvdb.episodes.filter(episode => episode.providerEpisodeId !== vA.id) });

  await changes.clearReportMissingForIgnore([{ ratingKey: TARGET, seasons: [2] }], h.save());
  assert.deepEqual(await h.flags(), { ...ALL_FLAGGED, seasonTwo: flagsOf(tB) }, "TMDB B is catalogued in season 5, so only TVDB B is in season 2");
  await changes.clearReportMissingForIgnore([{ ratingKey: TARGET, seasons: [1] }], h.save());
  assert.deepEqual(await h.flags(), { ...ALL_FLAGGED, inTarget: [], seasonTwo: flagsOf(tB) }, "TVDB A falls back to its saved season 1");
  await changes.clearReportMissingForIgnore([{ ratingKey: TARGET, seasons: [5] }], h.save());
  assert.deepEqual(await h.flags(), { ...ALL_FLAGGED, inTarget: [], seasonTwo: [] });
});

test("an Ignore that clears no flags saves exactly once during a Plex Scan run, changes no coverage revision and queues nothing", async (t) => {
  const h = await setup(t);
  // Any cached recheck would clear this pending state.
  store.beginCoverageRecheck(store.coverageState().revision);
  const before = { mappings: store.listCoverageMappings(), state: store.coverageState(), report: JSON.stringify(plexSavedState.report.read()) };
  let release!: () => void;
  const run = scanRuns.start("plex", () => new Promise<void>(resolve => { release = resolve; }));
  try {
    const result = await changes.clearReportMissingForIgnore([{ ratingKey: TARGET, seasons: [9] }], h.save(() => plexSavedState.options.patch({ ignoredSeasons: [{ ...forever(TARGET, "Target"), seasons: [9] }] })));
    assert.deepEqual(result, {});
    assert.equal(h.saves.count, 1);
    assert.deepEqual(readPlexPreferences().ignoredSeasons.map(rule => rule.seasons), [[9]], "The Ignore is saved");
    assert.deepEqual(store.listCoverageMappings(), before.mappings);
    assert.deepEqual(store.coverageState(), before.state);
    assert.equal(before.state.pending, 1, "No cached recheck ran");
    assert.equal(JSON.stringify(plexSavedState.report.read()), before.report);
  } finally {
    release();
    await run.settled;
  }
});

test("an Ignore that would clear flags during a Plex Scan run is refused with nothing saved", async (t) => {
  const h = await setup(t);
  const before = { mappings: store.listCoverageMappings(), state: store.coverageState(), settings: readPlexPreferences() };
  let release!: () => void;
  const run = scanRuns.start("plex", () => new Promise<void>(resolve => { release = resolve; }));
  try {
    await assert.rejects(changes.clearReportMissingForIgnore([{ ratingKey: OTHER }], h.save(() => plexSavedState.options.patch({ ignoredShows: [forever(OTHER, "Other")] }))),
      (error: unknown) => error instanceof store.CoverageError && error.code === "scan-active");
    assert.equal(h.saves.count, 0);
    assert.deepEqual({ mappings: store.listCoverageMappings(), state: store.coverageState(), settings: readPlexPreferences() }, before);
  } finally {
    release();
    await run.settled;
  }
});

test("a failing Ignore save rolls back the settings, flags and Manual Match and state revisions together", async (t) => {
  const h = await setup(t);
  const before = { mappings: store.listCoverageMappings(), state: store.coverageState(), settings: readPlexPreferences() };
  await assert.rejects(changes.clearReportMissingForIgnore([{ ratingKey: OTHER }], h.save(() => {
    plexSavedState.options.patch({ ignoredShows: [forever(OTHER, "Other")] });
    throw new Error("saved state unavailable");
  })), /saved state unavailable/);
  assert.equal(h.saves.count, 1);
  assert.deepEqual({ mappings: store.listCoverageMappings(), state: store.coverageState(), settings: readPlexPreferences() }, before);
});

test("an Ignore whose cached recheck fails after it was saved resolves with the saved Ignore, cleared flags and the comparison pending", async (t) => {
  const h = await setup(t);
  const last = h.missing(await h.status());
  const write = plexSavedState.report.write.bind(plexSavedState.report);
  let fail = true;
  t.mock.method(plexSavedState.report, "write", (report: Parameters<typeof write>[0]) => {
    if (fail) { fail = false; throw new Error("Injected cached recheck failure."); }
    return write(report);
  });
  const result = await changes.clearReportMissingForIgnore([{ ratingKey: OTHER }], h.save(() => plexSavedState.options.patch({ ignoredShows: [forever(OTHER, "Other")] })));
  assert.equal(fail, false, "The injected failure ran");
  assert.equal(result.coverageRevision, store.coverageState().revision, "The committed coverage revision");
  assert.deepEqual(readPlexPreferences().ignoredShows.map(show => show.ratingKey), [OTHER], "The Ignore stays saved");
  assert.deepEqual(await h.flags(), { ...ALL_FLAGGED, owned: [], unowned: [] }, "The cleared flags stay cleared");
  const state = store.coverageState();
  assert.equal(state.pending, 1);
  assert.ok(state.issues.some(issue => issue.id === "comparison-pending"));
  assert.deepEqual(h.missing(await h.status()), last, "No failed recheck published results");
});
