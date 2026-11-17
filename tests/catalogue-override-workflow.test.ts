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

test("an override to a never-downloaded series keeps last-good results with a pending Coverage Issue until the next scan", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11]; f.setSecond({tmdb:12,tvdb:2});
  await f.run();
  const other = await f.show("2");
  f.requests.length = 0;
  const saved = await f.select({identity:f.identity,provider:"tmdb",seriesId:11});
  assert.equal(saved.status,200);
  assert.deepEqual(f.requests,[],"the new catalogue is not downloaded by the save");
  let show = await f.show();
  assert.equal(show.tmdbId,10,"last-good results are kept");
  assert.deepEqual(missingTmdb(show),[1002],"A's episodes are never presented as B's");
  assert.deepEqual(await f.show("2"),other,"unrelated results are preserved");
  const issue = (await f.issues()).find(issue=>issue.id === `comparison-inputs:${f.identity}`);
  assert.match(issue?.cause || "",/TMDB series 11 has no saved catalogue/);
  assert.equal(saved.body.selection.tmdb.preferredId,11);
  assert.equal(saved.body.selection.tmdb.current.usingId,10,"the catalogue in use is still A");

  f.at(day(2)); show = await f.run();
  assert.equal(show.tmdbId,11);
  assert.ok(!(await f.issues()).some(issue=>issue.id === `comparison-inputs:${f.identity}`));
});

test("clearing an override returns the show to the automatic choice immediately", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  await f.select({identity:f.identity,provider:"tmdb",seriesId:11});
  f.at(day(2)); assert.equal((await f.run()).tmdbId,11);
  f.requests.length = 0;
  const cleared = await f.select({identity:f.identity,provider:"tmdb",seriesId:null});
  assert.equal(cleared.status,200);
  assert.deepEqual(f.requests,[]);
  const show = await f.show();
  assert.equal(show.tmdbId,10);
  assert.deepEqual(missingTmdb(show),[1002]);
  assert.equal(f.selection().tmdb.override,undefined);
  assert.equal(f.selection().tmdb.current?.usingId,10);
});

test("only a currently reported candidate of a provider with several IDs can be chosen", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  for (const body of [{identity:f.identity,provider:"tmdb",seriesId:12},{identity:f.identity,provider:"tvdb",seriesId:1},{identity:f.identity,provider:"imdb",seriesId:1},{identity:f.identity,provider:"tmdb",seriesId:"11"},{provider:"tmdb",seriesId:11}]) {
    const rejected = await f.select(body);
    assert.equal(rejected.status,400,JSON.stringify(body));
    assert.equal(rejected.body.code,"validation");
  }
  assert.equal(f.selection().tmdb.override,undefined);
});

test("a selection change is rejected while a Plex scan is active, and the persisted state is returned", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  f.at(day(2));
  const finish = await f.startHeldScan();
  const rejected = await f.select({identity:f.identity,provider:"tmdb",seriesId:11});
  assert.equal(rejected.status,409);
  assert.equal(rejected.body.code,"scan-active");
  assert.equal(rejected.body.selection.tmdb.override,undefined,"the response shows the persisted selection");
  assert.equal(rejected.body.selection.tmdb.preferredId,10);
  await finish();
  assert.equal(f.selection().tmdb.override,undefined);
  assert.equal((await f.show()).tmdbId,10);
});

test("report membership follows successful Plex inventory on either provider", async t => {
  const { reportData } = await import("./catalogue-override-harness");
  const f = await fixture(t);
  f.setSecond({tmdb:12,tvdb:2});
  await f.run();
  const listed = () => reportData.getReportData().multipleIdShows.map(entry => entry.identity);
  assert.deepEqual(listed(),[]);
  f.plex.tmdb = [10,11];
  f.at(day(2)); await f.run();
  assert.deepEqual(listed(),[f.identity]);
  assert.equal(reportData.getReportData().counts.multipleIdCount,1);
  f.plex.tmdb = [10]; f.plex.tvdb = [1,3];
  f.at(day(3)); await f.run();
  assert.deepEqual(listed(),[f.identity],"ambiguity on the other provider keeps the show listed");
  f.plex.tvdb = [1];
  f.at(day(4)); await f.run();
  assert.deepEqual(listed(),[],"the show leaves once neither provider has several IDs");
});

test("a TVDB override whose saved inputs cannot replay keeps last-good results until the next scan", async t => {
  const f = await fixture(t);
  f.plex.tvdb = [1,3];
  await f.run();
  f.requests.length = 0;
  const saved = await f.select({identity:f.identity,provider:"tvdb",seriesId:3});
  assert.equal(saved.status,200);
  assert.deepEqual(f.requests,[]);
  assert.equal((await f.show()).tvdbId,1);
  assert.ok((await f.issues()).some(issue=>issue.id === `comparison-inputs:${f.identity}`));
  f.at(day(2));
  assert.equal((await f.run()).tvdbId,3);
  assert.ok(!(await f.issues()).some(issue=>issue.id === `comparison-inputs:${f.identity}`));
});
