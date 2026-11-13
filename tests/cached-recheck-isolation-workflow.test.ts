import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";

// Cached Manual Match rechecks replay saved provider relationships offline. An
// unavailable episode relationship is an episode-scoped failure (GLOSSARY): it
// stays with its episode and never discards the whole show's comparison.

type Issue = { id: string; operation: string; scope: string; category?: string; provider?: string; cause: string; action: string; impacts?: string[]; causedBy?: string[]; show?: { ratingKey?: string }; episode?: { provider?: string; id?: number } };
const issuesOf = (result: unknown) => (result as { coverage: { issues: Issue[] } }).coverage.issues;
const pending = (result: unknown) => Boolean((result as { coverage: { pending?: unknown } }).coverage.pending);
const crosswalkIssues = (result: unknown) => issuesOf(result).filter(issue => issue.operation === "episode-crosswalk");
const showFailures = (result: unknown) => issuesOf(result).filter(issue => /^comparison-(failure|inputs):/.test(issue.id));

// TMDB numbers the season S1; TVDB numbers the same episodes S2, so every TVDB
// episode needs crosswalk evidence to be matched to the owned Plex files.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tmdb3: Episode = { provider: "TMDB", id: 9003, season: 1, episode: 3, name: "Three" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
const tvdb3: Episode = { provider: "TVDB", id: 303, season: 2, episode: 3, name: "Three" };
const catalogue = [tmdb1, tmdb2, tmdb3, tvdb1, tvdb2, tvdb3];
const owned = [tmdb1, tmdb2];
const found = (episode: Episode) => ({ tv_episode_results: [{ id: episode.id, show_id: 10, season_number: episode.season, episode_number: episode.episode, name: episode.name }] });
const missingKeys = (result: { report: { shows: { ratingKey: string; missing: { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[] }[] } }) =>
  (result.report.shows.find(item => item.ratingKey === "ratingKey:target")?.missing || []).flatMap(episode => episode.sources.map(source => `${source}:${source === "TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();

async function settled(status: () => Promise<unknown>) {
  let result = await status();
  for (let i = 0; i < 100 && pending(result); i++) { await new Promise(resolve => setTimeout(resolve, 10)); result = await status(); }
  return result as Awaited<ReturnType<typeof status>> & { report: { shows: { ratingKey: string; missing: { tmdbEpisodeId?: number; tvdbEpisodeId?: number; sources: string[] }[] }[] } };
}

test("a cached Manual Match recheck isolates a crosswalk whose request was rejected during the scan", async t => {
  const { rerun, state, save, status, requests } = await harness(t, catalogue, owned);
  state.statuses.set("/3/find/301", 404);
  state.bodies.set("/3/find/302", found(tmdb2));
  const scanned = await rerun();
  assert.deepEqual(missingKeys(scanned), ["TMDB:9003", "TVDB:301", "TVDB:303"]);
  const [requestCause] = issuesOf(scanned).filter(issue => issue.provider === "TMDB" && issue.episode?.id === 301);
  assert.equal(requestCause?.category, "Provider Lookup");

  const saved = await save([tmdb1, tvdb1]);
  assert.ok(saved.ok, await saved.clone().text());
  const before = requests.length;
  const rechecked = await settled(status);
  assert.equal(requests.length, before, "cached recheck performs no HTTP");
  assert.deepEqual(showFailures(rechecked), [], "the rejected episode crosswalk does not reject the whole show");
  assert.deepEqual(missingKeys(rechecked), ["TMDB:9003", "TVDB:303"], "the Manual Match collects TVDB 301; the saved TVDB 302 crosswalk still collects it");

  // The scan's rejected request remains the one current cause; the recheck explains the new coverage without claiming a new request.
  const after = issuesOf(rechecked).filter(issue => issue.provider === "TMDB" && issue.episode?.id === 301);
  assert.deepEqual(after.map(issue => issue.id), [requestCause.id]);
  assert.match(after[0].impacts!.join(" "), /A complete-set Manual Match established coverage for this episode, so it remains collected; this failed check is still unresolved/);

  // The next scan requests the crosswalk again and its recovery clears the cause.
  state.statuses.delete("/3/find/301");
  state.bodies.set("/3/find/301", found(tmdb1));
  requests.length = 0;
  const recovered = await rerun();
  assert.ok(requests.includes("/3/find/301"));
  assert.deepEqual(issuesOf(recovered), []);
  assert.deepEqual(missingKeys(recovered), ["TMDB:9003", "TVDB:303"]);
});

/** Fault injection: remove saved crosswalk responses from a show's saved comparison inputs. */
function dropSavedRelationships(ratingKey: string, matches: (relationship: string) => boolean) {
  const db = (globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync }).__shelfcheckDatabase!;
  const row = db.prepare("SELECT payload FROM shelfcheck_plex_generated_inputs WHERE cache_key=?").get(`comparison:${ratingKey}`) as { payload: string };
  const input = JSON.parse(row.payload) as { complete: boolean; relationships: Record<string, unknown> };
  assert.equal(input.complete, true, "the scan saved complete comparison inputs");
  const dropped = Object.keys(input.relationships).filter(matches);
  assert.ok(dropped.length, "a saved relationship was removed");
  for (const relationship of dropped) delete input.relationships[relationship];
  db.prepare("UPDATE shelfcheck_plex_generated_inputs SET payload=? WHERE cache_key=?").run(JSON.stringify(input), `comparison:${ratingKey}`);
}

test("a missing saved episode relationship stays with its episode during a cached recheck; the next scan requests it again", async t => {
  const { rerun, state, save, status, requests } = await harness(t, catalogue, owned);
  state.bodies.set("/3/find/301", found(tmdb1));
  state.bodies.set("/3/find/302", found(tmdb2));
  assert.deepEqual(missingKeys(await rerun()), ["TMDB:9003", "TVDB:303"]);
  dropSavedRelationships("ratingKey:target", relationship => relationship.includes("/find/301?"));

  // An unrelated Manual Match edit rechecks the show offline.
  const saved = await save([tmdb3, tvdb3]);
  assert.ok(saved.ok, await saved.clone().text());
  const before = requests.length;
  const rechecked = await settled(status);
  assert.equal(requests.length, before, "cached recheck performs no HTTP");
  assert.deepEqual(showFailures(rechecked), [], "one unavailable episode relationship does not reject the show");
  assert.deepEqual(missingKeys(rechecked), ["TMDB:9003", "TVDB:301", "TVDB:303"], "unrelated saved evidence still collects TVDB 302; no coverage is guessed for TVDB 301");
  const [issue, ...others] = crosswalkIssues(rechecked);
  assert.deepEqual(others, []);
  assert.equal(issue.scope, "episode");
  assert.deepEqual(issue.episode, { provider: "TVDB", id: 301, showId: 20, season: 2, episode: 1, title: "One" });
  assert.match(issue.cause, /TMDB external ID crosswalk could not be checked: The saved TMDB response for this episode is not available to the offline recheck; no request was made\./);
  assert.match(issue.action, /Run a Plex scan to request this crosswalk again; cached rechecks make no provider requests./);
  assert.doesNotMatch(JSON.stringify(issue), /request failed|network|outage/i, "a cached recheck is not described as a failed request");

  // The next requested scan looks the crosswalk up again and the evidence recovers.
  requests.length = 0;
  const scanned = await rerun();
  assert.ok(requests.includes("/3/find/301"));
  assert.deepEqual(crosswalkIssues(scanned), []);
  assert.deepEqual(missingKeys(scanned), ["TMDB:9003", "TVDB:303"]);
});

test("a missing saved show-level relationship is a shared-input failure: the recheck keeps last-good results", async t => {
  const { rerun, state, save, status, requests } = await harness(t, catalogue, owned);
  state.bodies.set("/3/find/301", found(tmdb1));
  state.bodies.set("/3/find/302", found(tmdb2));
  const scanned = await rerun();
  dropSavedRelationships("ratingKey:target", relationship => relationship.endsWith("/v4/series/20"));
  const saved = await save([tmdb3, tvdb3]);
  assert.ok(saved.ok, await saved.clone().text());
  const before = requests.length;
  const rechecked = await settled(status);
  assert.equal(requests.length, before, "cached recheck performs no HTTP");
  assert.deepEqual(showFailures(rechecked).map(issue => issue.id), ["comparison-inputs:ratingKey:target"]);
  assert.deepEqual(missingKeys(rechecked), missingKeys(scanned), "last-good results are kept");
  assert.deepEqual(crosswalkIssues(rechecked), []);
});

test("Report Missing keeps its precedence over a complete-set Manual Match when a saved relationship is unavailable to the recheck", async t => {
  const { rerun, state, save, setFlags, status, requests, missing } = await harness(t, catalogue, owned);
  state.bodies.set("/3/find/301", found(tmdb1));
  state.bodies.set("/3/find/302", found(tmdb2));
  await rerun();
  dropSavedRelationships("ratingKey:target", relationship => /\/find\/30[12]\?/.test(relationship));
  const saved = await save([tmdb1, tvdb1]);
  assert.ok(saved.ok, await saved.clone().text());
  const mappingId = (await saved.json()).mapping.id as string;
  const before = requests.length;
  const matched = await settled(status);
  assert.deepEqual(showFailures(matched), []);
  assert.deepEqual(missingKeys(matched), ["TMDB:9003", "TVDB:302", "TVDB:303"], "the complete-set Manual Match collects TVDB 301; TVDB 302 lost only its own evidence");
  assert.deepEqual(crosswalkIssues(matched).map(issue => issue.episode?.id).sort(), [301, 302]);

  await setFlags(mappingId, [tvdb1]);
  const reported = await settled(status);
  assert.equal(requests.length, before, "cached rechecks perform no HTTP");
  assert.deepEqual(showFailures(reported), []);
  assert.equal(missing(reported as never)["TVDB:301"], "reported-missing", "Report Missing outranks every method");
  assert.equal(missing(reported as never)["TVDB:302"], "missing");
});
