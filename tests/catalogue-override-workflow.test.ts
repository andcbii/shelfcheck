import assert from "node:assert/strict";
import { catalogueNotices } from "../lib/catalogue-notice";
import test from "node:test";
import { catalogues, fixture, missingTmdb, day, plexScan } from "./catalogue-override-harness";

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

test("an active Plex scan rejects a selection change before validating it", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  f.at(day(2));
  const finish = await f.startHeldScan();
  for (const body of [{identity:f.identity,provider:"tmdb",seriesId:12},{identity:f.identity,provider:"imdb",seriesId:1},{provider:"tmdb",seriesId:11}]) {
    const rejected = await f.select(body);
    assert.equal(rejected.status,409,JSON.stringify(body));
    assert.equal(rejected.body.code,"scan-active");
  }
  await finish();
});

test("a TVDB override to a previously downloaded catalogue rechecks immediately", async t => {
  const f = await fixture(t);
  f.plex.tvdb = [1,3];
  await f.run();
  await f.select({identity:f.identity,provider:"tvdb",seriesId:3});
  f.at(day(2)); assert.equal((await f.run()).tvdbId,3);
  await f.select({identity:f.identity,provider:"tvdb",seriesId:null});
  f.at(day(3)); assert.equal((await f.run()).tvdbId,1);
  f.requests.length = 0;
  const saved = await f.select({identity:f.identity,provider:"tvdb",seriesId:3});
  assert.equal(saved.status,200);
  assert.deepEqual(f.requests,[],"no scan and no provider download");
  const show = await f.show();
  assert.equal(show.tvdbId,3,"the saved TVDB catalogue is compared at once");
  assert.deepEqual(show.missing.flatMap(episode => episode.tvdbEpisodeId ? [episode.tvdbEpisodeId] : []),[3002]);
  assert.equal(f.selection().tvdb.current?.usingId,3);
  assert.ok(!(await f.issues()).some(issue=>issue.id === `comparison-inputs:${f.identity}`));
});

test("a Manual Match recheck keeps a pending override's comparison issue while the overridden catalogue is not compared", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  await f.select({identity:f.identity,provider:"tmdb",seriesId:11});
  const pending = async () => (await f.issues()).find(issue=>issue.id === `comparison-inputs:${f.identity}`);
  assert.match((await pending())?.cause || "",/TMDB series 11/);
  f.requests.length = 0;
  await plexScan.requestCoverageRecheck({members:[{provider:"TMDB",id:1001,showId:10,show:"TMDB 10",title:"Episode 1",season:1,episode:1,url:""}]});
  assert.deepEqual(f.requests,[]);
  assert.equal((await f.show()).tmdbId,10,"last-good results are kept");
  assert.match((await pending())?.cause || "",/TMDB series 11/,"the override is still not compared");
  assert.equal(f.selection().tmdb.current?.usingId,10);
});

test("saving an override again keeps the series' earlier unavailable provenance", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11];
  await f.run();
  await f.select({identity:f.identity,provider:"tmdb",seriesId:11});
  f.at(day(2)); await f.run();
  f.tmdb[11].fail = true;
  f.at(day(25)); await f.run();
  assert.equal(f.selection().tmdb.current?.state,"saved-unavailable","B's 20-day refresh failed");
  await f.select({identity:f.identity,provider:"tmdb",seriesId:null});
  assert.equal(f.selection().tmdb.current?.usingId,10);
  await f.select({identity:f.identity,provider:"tmdb",seriesId:11});
  const current = f.selection().tmdb.current!;
  assert.equal(current.usingId,11);
  assert.equal(current.state,"saved-unavailable","B is still unavailable; its saved catalogue is in use");
  assert.equal(current.preferredFailedAt,day(25));
  assert.equal(current.preferredDownloadedAt,day(2));
});

test("changing the TVDB choice of a show without Plex TMDB IDs re-resolves its derived TMDB series offline", async t => {
  const f = await fixture(t);
  f.plex.tmdb = []; f.plex.tvdb = [1,3];
  f.find[1] = 10; f.find[3] = 11;
  let show = await f.run();
  assert.deepEqual([show.tmdbId,show.tvdbId],[10,1]);
  await f.select({identity:f.identity,provider:"tvdb",seriesId:3});
  f.at(day(2)); show = await f.run();
  assert.deepEqual([show.tmdbId,show.tvdbId],[11,3]);

  f.requests.length = 0;
  const cleared = await f.select({identity:f.identity,provider:"tvdb",seriesId:null});
  assert.equal(cleared.status,200,JSON.stringify(cleared.body));
  assert.deepEqual(f.requests,[],"no scan and no provider request");
  show = await f.show();
  assert.deepEqual([show.tmdbId,show.tvdbId],[10,1],"the TMDB series TVDB 1 resolves to, as a live scan would compare");
  assert.deepEqual(missingTmdb(show),[1002]);
  assert.equal(f.selection().tmdb.current?.usingId,10);
  assert.equal(f.selection().tmdb.current?.derivedFrom,1);
  assert.ok(!(await f.issues()).some(issue=>issue.id === `comparison-inputs:${f.identity}`));

  const saved = await f.select({identity:f.identity,provider:"tvdb",seriesId:3});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.deepEqual(f.requests,[]);
  show = await f.show();
  assert.deepEqual([show.tmdbId,show.tvdbId],[11,3]);
  assert.deepEqual(missingTmdb(show),[1102,1103]);
  assert.equal(f.selection().tmdb.current?.usingId,11);
  assert.equal(f.selection().tmdb.current?.derivedFrom,3);
});

test("a TVDB choice without saved TMDB association evidence keeps last-good results pending instead of a mixed pair", async t => {
  const f = await fixture(t);
  f.plex.tmdb = []; f.plex.tvdb = [1,3];
  f.find[1] = 10; f.find[3] = 11;
  await f.run();
  await f.select({identity:f.identity,provider:"tvdb",seriesId:3});
  f.at(day(2)); await f.run();
  // The saved TMDB answer for TVDB 1 is gone, so its TMDB series cannot be resolved offline.
  const saved = catalogues.readPlexInputs().comparisons[f.identity]!;
  const association = Object.keys(saved.relationships).find(key => key.includes("/find/1?"));
  assert.ok(association,"the scan saved TVDB 1's TMDB association for an offline switch");
  delete saved.relationships[association];
  catalogues.savePlexComparison(f.identity,saved);

  f.requests.length = 0;
  const cleared = await f.select({identity:f.identity,provider:"tvdb",seriesId:null});
  assert.equal(cleared.status,200,JSON.stringify(cleared.body));
  assert.deepEqual(f.requests,[]);
  const show = await f.show();
  assert.deepEqual([show.tmdbId,show.tvdbId],[11,3],"last-good results are kept");
  assert.match((await f.issues()).find(issue=>issue.id === `comparison-inputs:${f.identity}`)?.cause || "",/association for TVDB series 1 is not saved/);
  assert.equal(f.selection().tmdb.current?.usingId,11);
  assert.equal(f.selection().tmdb.current?.derivedFrom,3);
  assert.equal(f.selection().tvdb.current?.usingId,3);
});

test("when a dependent provider input fails, the persisted catalogues in use are those the kept results compared", async t => {
  const f = await fixture(t);
  f.plex.tmdb = [10,11]; f.plex.tvdb = [];
  f.tmdb[11].tvdb = 3;
  let show = await f.run();
  assert.deepEqual([show.tmdbId,show.tvdbId],[10,1]);
  await f.select({identity:f.identity,provider:"tmdb",seriesId:11});
  f.tvdb[3].fail = true;
  f.at(day(2)); show = await f.run();
  assert.deepEqual([show.tmdbId,show.tvdbId],[10,1],"last-good results are kept");
  assert.deepEqual(missingTmdb(show),[1002]);
  const selection = f.selection();
  assert.equal(selection.tmdb.current?.usingId,show.tmdbId,"TMDB in use is the catalogue the results compared");
  assert.equal(selection.tvdb.current?.usingId,show.tvdbId,"TVDB in use is the catalogue the results compared");
  assert.equal(selection.tmdb.preferredId,11,"the new preference is kept");
  assert.match(catalogueNotices(selection)[0]?.text || "",/Preferred TMDB 11 · Using .*10\)? until compared/,"the new preference shows as pending");
});

test("a scan falling back to another TVDB series resolves the TMDB series of the one compared when Plex reports no TMDB ID", async t => {
  const f = await fixture(t);
  f.plex.tmdb = []; f.plex.tvdb = [1,3];
  f.find[1] = 10; f.find[3] = 11;
  await f.run();
  await f.select({identity:f.identity,provider:"tvdb",seriesId:3});
  f.tvdb[3].fail = true;
  f.at(day(2)); const show = await f.run();
  assert.deepEqual([show.tmdbId,show.tvdbId],[10,1],"TMDB follows the fallback TVDB series, never the unavailable preference");
  assert.deepEqual(missingTmdb(show),[1002]);
  const selection = f.selection();
  assert.equal(selection.tvdb.current?.state,"fallback");
  assert.equal(selection.tvdb.current?.usingId,1);
  assert.equal(selection.tmdb.current?.usingId,10);
  assert.equal(selection.tmdb.current?.derivedFrom,1);
});

test("a cached recheck reports a several-ID provider's untried preference before another provider's missing saved catalogue", async t => {
  const f = await fixture(t);
  f.plex.tvdb = [1,3];
  await f.run();
  // TMDB's one saved catalogue becomes unusable, so both providers block the offline comparison.
  const tmdb = catalogues.readPlexInputs().tmdb["10"]!;
  catalogues.savePlexCatalogue("tmdb",10,{...tmdb,episodes:undefined as unknown as typeof tmdb.episodes});

  f.requests.length = 0;
  const saved = await f.select({identity:f.identity,provider:"tvdb",seriesId:3});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.deepEqual(f.requests,[]);
  const show = await f.show();
  assert.deepEqual([show.tmdbId,show.tvdbId],[10,1],"last-good results are kept");
  assert.match((await f.issues()).find(issue=>issue.id === `comparison-inputs:${f.identity}`)?.cause || "",/^TVDB series 3 has no saved catalogue from the last 60 days/);
});
