import assert from "node:assert/strict";
import test from "node:test";
import { groupPlexShows, plexEpisodeFingerprint, showProviderIds, type PlexMetadata } from "../lib/plex-inventory";

const show = (ratingKey: string, plexGuid: string, tmdbId: number, tvdbId: number): PlexMetadata => ({
  ratingKey,
  guid: `plex://show/${plexGuid}`,
  Guid: [{ id: `tmdb://${tmdbId}` }, { id: `tvdb://${tvdbId}` }],
});

test("groups separately managed Plex shows with the same complete provider identity", () => {
  const groups = groupPlexShows([
    show("baseball", "baseball", 19215, 81381),
    show("tenth-inning", "tenth-inning", 19215, 81381),
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].records.map((record) => record.ratingKey), ["baseball", "tenth-inning"]);
});

test("does not merge distinct TMDB series that share a TVDB series", () => {
  const groups = groupPlexShows([
    show("animaniacs-1993", "animaniacs-1993", 82, 72879),
    show("animaniacs-2020", "animaniacs-2020", 107124, 72879),
  ]);

  assert.equal(groups.length, 2);
});

test("still groups duplicate records by Plex identity when provider IDs differ", () => {
  const groups = groupPlexShows([
    show("first", "shared", 1, 10),
    show("second", "shared", 2, 20),
  ]);

  assert.equal(groups.length, 1);
});

test("episode fingerprint changes when an episode is added without changing the show", () => {
  const before = [{ ratingKey: "1", updatedAt: 100 }];
  const after = [...before, { ratingKey: "2", updatedAt: 100 }];
  assert.notEqual(plexEpisodeFingerprint(before), plexEpisodeFingerprint(after));
});

test("show-level provider IDs keep every distinct series ID in numeric order", () => {
  const ids = showProviderIds([{ id: "tmdb://337142" }, { id: "tvdb://73817" }, { id: "tmdb://2150" }, { id: "tmdb://337142" }, { id: "imdb://tt0074074" }, { id: "TMDB://10" }, { id: "tmdb://9" }]);
  assert.deepEqual(ids, { tmdb: [9, 10, 2150, 337142], tvdb: [73817] });
  assert.deepEqual(showProviderIds(undefined), { tmdb: [], tvdb: [] });
});

test("a show-level GUID whose number no provider lookup accepts is not a series ID", () => {
  // 0 and a number beyond the safe integer range (here it would round to 2^53) name no series.
  const ids = showProviderIds([{ id: "tmdb://0" }, { id: "tmdb://9007199254740993" }, { id: "tmdb://10" }, { id: "tvdb://99999999999999999999" }, { id: "tvdb://20" }]);
  assert.deepEqual(ids, { tmdb: [10], tvdb: [20] });
});

test("grouping does not depend on Plex GUID order", () => {
  const forward: PlexMetadata = { ratingKey: "a", Guid: [{ id: "tmdb://5" }, { id: "tmdb://3" }, { id: "tvdb://9" }] };
  const reversed: PlexMetadata = { ratingKey: "b", Guid: [{ id: "tvdb://9" }, { id: "tmdb://3" }, { id: "tmdb://5" }] };
  const lowestPair: PlexMetadata = { ratingKey: "c", Guid: [{ id: "tmdb://3" }, { id: "tvdb://9" }] };
  assert.deepEqual(groupPlexShows([forward, reversed, lowestPair]).map(group => group.records.map(record => record.ratingKey)), [["a", "b", "c"]]);
  assert.deepEqual(groupPlexShows([lowestPair, reversed, forward]).map(group => group.records.map(record => record.ratingKey)), [["c", "b", "a"]]);
});

test("records sharing only one provider stay separate whatever their GUID order", () => {
  const groups = groupPlexShows([
    { ratingKey: "a", Guid: [{ id: "tvdb://9" }, { id: "tmdb://5" }, { id: "tmdb://3" }] },
    { ratingKey: "b", Guid: [{ id: "tmdb://5" }, { id: "tvdb://8" }] },
  ]);
  assert.equal(groups.length, 2);
});
