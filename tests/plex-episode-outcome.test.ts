import assert from "node:assert/strict";
import test from "node:test";
import { providerEpisodeIsOwned, resolveTvdbEpisode, type TvdbResolutionEvidence } from "../lib/plex-episode-outcome";

const none: TvdbResolutionEvidence = { directTvdb: false, directImdb: false, trakt: false, tmdb: false, compound: false };

test("TVDB reconciliation uses the documented precedence", () => {
  assert.equal(resolveTvdbEpisode({ ...none, directTvdb: true, directImdb: true, trakt: true, tmdb: true, compound: true }, true), "direct-tvdb");
  assert.equal(resolveTvdbEpisode({ ...none, directImdb: true, trakt: true, tmdb: true, compound: true }, true), "direct-imdb");
  assert.equal(resolveTvdbEpisode({ ...none, trakt: true, tmdb: true, compound: true }, true), "trakt");
  assert.equal(resolveTvdbEpisode({ ...none, tmdb: true, compound: true }, true), "tmdb");
  assert.equal(resolveTvdbEpisode({ ...none, compound: true }, true), "compound");
});

test("compound evidence is ignored when Auto Compound Episodes is disabled", () => {
  assert.equal(resolveTvdbEpisode({ ...none, compound: true }, false), "missing");
});

test("an episode without ownership evidence remains missing", () => {
  assert.equal(resolveTvdbEpisode(none, true), "missing");
});

test("a locally owned TMDB identity prevents a coordinate-shift false positive", () => {
  assert.equal(providerEpisodeIsOwned({ source: "TMDB", providerEpisodeId: 1005, localTmdbEpisodeIds: new Set([1005]), tvdbEvidence: none, autoCompoundEpisodes: true }), true);
  assert.equal(providerEpisodeIsOwned({ source: "TMDB", providerEpisodeId: 1006, localTmdbEpisodeIds: new Set([1005]), tvdbEvidence: none, autoCompoundEpisodes: true }), false);
});
