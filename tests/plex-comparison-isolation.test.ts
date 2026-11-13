import assert from "node:assert/strict";
import test from "node:test";
import { comparePlexShow, type PlexComparisonInput, type ProviderEpisode } from "../lib/plex-comparison";

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

test("when Report Missing precedence cannot be evaluated, no coverage is granted over a possible flag", () => {
  const throwing = { id: "x", get members(): never { throw new Error("saved flags unreadable"); } };
  const result = comparePlexShow(input({ mappings: [throwing] as unknown as PlexComparisonInput["mappings"] }));
  // Every episode's precedence check failed, so even coordinate- and directly-owned episodes stay missing.
  assert.deepEqual(missingIds(result), [1, 2, 3, 4]);
  assert.deepEqual(result.episodeFailures.map(failure => `${failure.method}:${failure.episode.id}`), ["report-missing:1", "report-missing:2", "report-missing:3", "report-missing:4"]);
});
