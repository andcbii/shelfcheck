import assert from "node:assert/strict";
import test from "node:test";
import { groupPlexShows, type PlexMetadata } from "../lib/plex-inventory";

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
