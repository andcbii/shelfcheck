import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { comparePlexShow, type PlexComparisonInput, type ProviderEpisode } from "../lib/plex-comparison";
const hook = registerHooks({ resolve(s, c, next) { return s === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(s, c); } });
const { episodeCheckIssue } = await import("../lib/episode-check-issues");
hook.deregister();

// The shared comparison engine (scans and cached rechecks) isolates an
// Episode-scoped failure in a final decision to that episode and method.

const tmdb = (id: number, episode: number): ProviderEpisode => ({ source: "TMDB", season: 1, episode, providerEpisodeId: id, title: `Episode ${episode}` });

function input(overrides: Partial<PlexComparisonInput> = {}): PlexComparisonInput {
  return {
    ratingKey: "show", primary: { title: "Show" }, tmdbShow: { id: 10 }, tvdbId: 20, tmdbSeriesMatches: [],
    providerEpisodes: [tmdb(1, 1), tmdb(2, 2), tmdb(3, 3), tmdb(4, 4)],
    localEpisodes: new Set(["1:1"]), localProviderEpisodes: [], localTmdbEpisodeIds: new Set(),
    libraryTmdbEpisodeIds: new Set([3]), coordinateMissingTvdbIds: new Set(), directTvdbSatisfied: new Set(),
    directImdbSatisfied: new Set(), traktSatisfied: new Set(), tmdbSatisfied: new Set(), autoMatchEvidence: new Map(),
    mappings: [], manualInventory: [], autoCompoundEpisodes: true, ...overrides,
  };
}
/** Library evidence whose lookup fails for one episode, as an unexpected matching exception would. */
class FailingIds extends Set<number> {
  constructor(values: number[], private failing: number) { super(values); }
  override has(value: number) { if (value === this.failing) throw new TypeError("evidence unavailable"); return super.has(value); }
}
const missingIds = (result: ReturnType<typeof comparePlexShow>) => result.missing.map(episode => episode.tmdbEpisodeId);

test("a failed automatic-evidence decision leaves the episode missing without discarding its siblings", () => {
  const result = comparePlexShow(input({ libraryTmdbEpisodeIds: new FailingIds([3], 2) }));
  assert.deepEqual(missingIds(result), [2, 4], "no guessed coverage; unrelated episode 4 is still missing and 3 still collected");
  assert.deepEqual(result.episodeFailures.map(failure => ({ ...failure, reason: undefined })), [{ operation: "episode-decision", method: "automatic-evidence", episode: { provider: "TMDB", id: 2, season: 1, episode: 2, title: "Episode 2" }, kind: "exception", reason: undefined }]);
  assert.match(result.episodeFailures[0].reason, /evidence unavailable/);
});

test("a later complete-set Manual Match still collects an episode after an earlier method fails, and the failure is kept", () => {
  const mapping = { id: "m", members: [{ provider: "TMDB" as const, id: 2 }, { provider: "TVDB" as const, id: 200 }] };
  const result = comparePlexShow(input({ libraryTmdbEpisodeIds: new FailingIds([3], 2), mappings: [mapping] as PlexComparisonInput["mappings"], manualInventory: [{ identities: [{ provider: "TVDB", id: 200 }] }] as PlexComparisonInput["manualInventory"] }));
  assert.deepEqual(missingIds(result), [4]);
  assert.deepEqual(result.manualCoverage.map(item => item.mappingId), ["m"]);
  assert.equal(result.coverageOutcomes.find(outcome => outcome.id === 2)?.status, "manual");
  assert.equal(result.episodeFailures[0].coveredBy, "manual-match");
});

/** The impact 05 — Scan Issues shows for one episode's failed check. */
const impactOf = (result: ReturnType<typeof comparePlexShow>, id: number) => episodeCheckIssue({ ratingKey: "show" }, result.episodeFailures.find(failure => failure.episode.id === id && failure.method !== "manual-match")!).impacts!.join(" ");

test("when Report Missing cannot be evaluated, other valid methods still collect and unflagged specials stay hidden", () => {
  const throwing = { id: "x", get members(): never { throw new Error("saved flags unreadable"); } };
  const special: ProviderEpisode = { source: "TMDB", season: 0, episode: 1, providerEpisodeId: 5, title: "Special" };
  const result = comparePlexShow(input({ mappings: [throwing] as unknown as PlexComparisonInput["mappings"], providerEpisodes: [tmdb(1, 1), tmdb(2, 2), tmdb(3, 3), tmdb(4, 4), special] }));
  // Coordinates collect 1 and owned TMDB identity collects 3; 2 and 4 stay missing; the unflagged special is not listed.
  assert.deepEqual(missingIds(result), [2, 4]);
  // The unreadable Manual Matches also fail the complete-set check of the uncollected episodes.
  assert.deepEqual(result.episodeFailures.map(failure => `${failure.method}:${failure.episode.id}`), ["report-missing:1", "report-missing:2", "manual-match:2", "report-missing:3", "report-missing:4", "manual-match:4", "report-missing:5"]);
  assert.match(impactOf(result, 1), /Plex season and episode numbering established coverage for this episode, so it remains collected/);
  assert.match(impactOf(result, 3), /Automatic provider evidence established coverage for this episode, so it remains collected/);
  assert.match(impactOf(result, 2), /remains in missing results/);
  assert.match(impactOf(result, 5), /not listed in missing results/);
  assert.doesNotMatch(impactOf(result, 5), /remains in missing results/);
});

test("a missing result that cannot be built is not claimed to remain in missing results", () => {
  const broken = { source: "TMDB", season: 1, episode: 2, providerEpisodeId: 2, title: "Episode 2", get airDate(): string { throw new TypeError("air date unreadable"); } } as ProviderEpisode;
  const result = comparePlexShow(input({ providerEpisodes: [tmdb(1, 1), broken, tmdb(4, 4)] }));
  assert.deepEqual(missingIds(result), [4], "siblings are still listed");
  assert.deepEqual(result.episodeFailures.map(failure => `${failure.method}:${failure.episode.id}`), ["missing-result:2"]);
  assert.match(impactOf(result, 2), /missing result could not be built, so this episode is not listed in missing results/);
});
