import assert from "node:assert/strict";
import test from "node:test";
import { fixture, missingTmdb, day } from "./catalogue-override-harness";

test("saving an override immediately rechecks the show from its saved catalogue, without HTTP", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  await f.select({identity:f.identity,provider:"tmdb",seriesId:11});
  f.at(day(2)); await f.run();
  await f.select({identity:f.identity,provider:"tmdb",seriesId:null});
  f.at(day(3)); let show = await f.run();
  assert.equal(show.tmdbId,10);

  f.requests.length = 0;
  const saved = await f.select({identity:f.identity,provider:"tmdb",seriesId:11});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.deepEqual(f.requests,[],"no scan and no provider download");
  show = await f.show();
  assert.equal(show.tmdbId,11,"the show is compared against the newly preferred catalogue");
  assert.deepEqual(missingTmdb(show),[1102,1103]);
  assert.equal(f.selection().tmdb.override,11);
  assert.equal(f.selection().tmdb.current?.usingId,11);
  assert.equal(f.selection().tmdb.current?.state,"preferred");
  assert.equal(saved.body.selection.tmdb.override,11,"the response carries the persisted selection");

  f.at(day(4)); await f.run();
  assert.equal(f.tmdbDownloads(11),1,"the next scan meets the refresh obligation for the new choice");
});
