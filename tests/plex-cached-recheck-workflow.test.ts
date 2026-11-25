import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {registerHooks} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import type {DatabaseSync} from "node:sqlite";
import test from "node:test";
const hook=registerHooks({resolve(s,c,next){return s==="server-only" ? {url:"data:text/javascript,export%20%7B%7D",shortCircuit:true} : next(s,c);}});
const api=await import("../app/api/plex/manual-coverage/route");
const scan=await import("../app/api/plex/scan/route");
const config=await import("../lib/server-config");
const ignoreResults = await import("../lib/ignore-results");
hook.deregister();
// These shows have no TMDB ID from Plex or TVDB: since SHELFCHECK-27 (ADR-0006) each has a missing-ID Scan Issues entry, which these checks are not about.
const withoutMissingIds = (issues: {lookup?:{failureKind?:string}}[]) => issues.filter(issue=>issue.lookup?.failureKind !== "missing-id");

// Manual Matches cover one way (ADR-0008): each TVDB-ordered show's combined episode is covered
// by the TMDB split parts that the ignored TMDB source show owns.
test("cached Manual Match edits reconcile old and new shows without HTTP, preserve unrelated results, and refresh only affected catalogues after restart",async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),"cached-recheck-"));
  const beforeData=process.env.SHELFCHECK_DATA_DIR,beforeConfig=process.env.SHELFCHECK_CONFIG_DIR;
  process.env.SHELFCHECK_DATA_DIR=dir;process.env.SHELFCHECK_CONFIG_DIR=dir;
  const global=globalThis as typeof globalThis & {__shelfcheckDatabase?:DatabaseSync};
  t.after(()=>{global.__shelfcheckDatabase?.close();delete global.__shelfcheckDatabase;if(beforeData===undefined)delete process.env.SHELFCHECK_DATA_DIR;else process.env.SHELFCHECK_DATA_DIR=beforeData;if(beforeConfig===undefined)delete process.env.SHELFCHECK_CONFIG_DIR;else process.env.SHELFCHECK_CONFIG_DIR=beforeConfig;rmSync(dir,{recursive:true,force:true});});
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  ignoreResults.savedScanState("plex").options.patch({ignoredShows:[{ratingKey:"ratingKey:source",title:"Ignored source"}],diagnosticsEnabled:false});
  const requests:string[]=[];
  let blockSave=false,blockCatalogue=false,changeFeedUnavailable=false;
  let enterSave!:()=>void,releaseSave!:()=>void,releaseCatalogue!:()=>void;
  const saveEntered=new Promise<void>(resolve=>{enterSave=resolve;});
  const saveBlocked=new Promise<void>(resolve=>{releaseSave=resolve;});
  const catalogueBlocked=new Promise<void>(resolve=>{releaseCatalogue=resolve;});
  // Plex shows 10, 11 and 12 are TVDB series 20, 21 and 22; each has one combined episode, ID series × 10.
  const counts=()=>[20,21,22].map(id=>requests.filter(url=>new URL(url).pathname===`/v4/series/${id}/episodes/default`).length);
  const showOf=(result:{report:{shows:{tvdbId:number;missing:{tvdbEpisodeId:number}[]}[]}},plexKey:number)=>result.report.shows.find(show=>show.tvdbId===plexKey+10)!;
  t.mock.method(globalThis,"fetch",async(input:string|URL|Request)=>{
    const u=new URL(String(input));requests.push(String(u));
    if(blockSave && u.pathname.match(/\/v4\/episodes\/\d+\/extended$/)){blockSave=false;enterSave();await saveBlocked;}
    if(blockCatalogue && u.pathname.match(/\/v4\/series\/\d+\/episodes\/default$/))await catalogueBlocked;
    if(changeFeedUnavailable && u.pathname==="/v4/updates")return Response.json({}, {status:401});
    const series=Number(u.pathname.match(/\/v4\/series\/(\d+)/)?.[1]);
    let body:unknown;
    if(u.hostname==="plex"){
      if(u.pathname==="/library/sections")body={MediaContainer:{Directory:[{key:"1",type:"show"}]}};
      else if(u.pathname.includes("/sections/"))body={MediaContainer:{Metadata:[10,11,12].map(id=>({ratingKey:String(id),title:id===10 ? "Animaniacs" : `Show ${id}`,Guid:[{id:`tvdb://${id+10}`}]})).concat([{ratingKey:"source",title:"Ignored source",Guid:[{id:"tmdb://30"}]}])}};
      else if(u.pathname.includes("allLeaves"))body={MediaContainer:{Metadata:u.pathname.includes("/source/") ? [300,301,302].map(id=>({ratingKey:`part${id}`,parentIndex:8,index:id-299,Guid:[{id:`tmdb://${id}`}]})) : []}};
      else {const key=u.pathname.split("/").pop();body={MediaContainer:{Metadata:[{ratingKey:key,title:Number(key)===10 ? "Animaniacs" : `Show ${key}`,Guid:[{id:`tvdb://${Number(key)+10}`}]}]}};}
    }else if(u.pathname==="/v4/login")body={data:{token:"test"}};
    else if(u.pathname.match(/\/v4\/episodes\/\d+\/extended/)){const episode=Number(u.pathname.split("/")[3]);body={data:{id:episode,seriesId:episode/10,seasonNumber:3,number:18,name:"Combined"}};}
    else if(u.pathname.match(/\/v4\/series\/\d+\/episodes\/default$/))body={data:{episodes:[{id:series*10,seasonNumber:3,number:18,name:"Combined",aired:"2020-01-01"}]}};
    else if(u.pathname.match(/\/v4\/series\/\d+$/))body={data:{id:series,name:series===20 ? "Animaniacs" : `Show ${series-10}`,slug:`show-${series}`}};
    else if(u.pathname.match(/\/3\/tv\/30\/season\/8\/episode\/\d+$/)){const episode=Number(u.pathname.split("/").pop());body={id:episode+299,season_number:8,episode_number:episode,name:`Part ${episode+299}`};}
    else if(u.pathname==="/3/tv/30")body={id:30,name:"Ignored source",seasons:[{season_number:8}]};
    else if(u.pathname.includes("/find/"))body={tv_results:[],tv_episode_results:[]};
    else if(u.pathname==="/3/tv/changes")body={results:[],total_pages:1};
    else if(u.pathname==="/v4/updates")body={data:[]};
    else throw new Error("Unexpected HTTP: "+u);
    return Response.json(body);
  });
  const request=(body:unknown)=>new Request("http://localhost/api/plex/manual-coverage",{method:"POST",body:JSON.stringify(body)});
  const report=async()=>(await (await scan.GET()).json());
  const rerun=async()=>{await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));for(let i=0;i<300;i++){const result=await report();if(result.scan.status!=="running"){assert.equal(result.scan.status,"completed",result.scan.error);return result;}await new Promise(r=>setTimeout(r,10));}throw new Error("scan timeout");};
  /** A preview of the combined episode of Plex show `show` and these TMDB parts of the source. */
  const preview=async(show:number,parts:number[])=>{const response=await api.POST(request({action:"resolve",urls:[`tvdb:${(show+10)*10}`,...parts.map(id=>`tmdb:${id} show:30 season:8 episode:${id-299}`)]}));assert.equal(response.status,200,await response.clone().text());return (await response.json()).preview;};
  const initial=await rerun();
  const unrelated=showOf(initial,12);
  assert.deepEqual(counts(),[1,1,1]);
  const firstPreview=await preview(10,[300,301]);
  const beforeSave=requests.length;
  const save=await api.POST(request({action:"save",preview:firstPreview}));assert.equal(save.status,201);
  assert.deepEqual(requests.slice(beforeSave).map(url=>new URL(url).pathname),["/v4/login","/v4/episodes/200/extended","/v4/series/20","/3/tv/30/season/8/episode/1","/3/tv/30","/3/tv/30/season/8/episode/2","/3/tv/30"],"Only canonical save validation may use HTTP");
  const saved=(await save.json()).mapping;
  let current=await report();
  assert.deepEqual(showOf(current,10).missing,[]);
  assert.deepEqual(showOf(current,12),unrelated);
  assert.equal(current.report.lastScan,initial.report.lastScan);
  assert.deepEqual(counts(),[1,1,1]);
  const replacement=await preview(11,[300,301]);
  const edit=await api.POST(request({action:"save",id:saved.id,revision:saved.revision,preview:replacement}));assert.equal(edit.status,200);
  let edited=(await edit.json()).mapping;
  current=await report();
  assert.equal(showOf(current,10).missing[0].tvdbEpisodeId,200);
  assert.deepEqual(showOf(current,11).missing,[]);
  assert.deepEqual(showOf(current,12),unrelated);
  const secondPreview=await preview(10,[302]);
  const second=await api.POST(request({action:"save",preview:secondPreview}));assert.equal(second.status,201);let secondMapping=(await second.json()).mapping;
  const beforeConcurrentDelete=requests.length;
  const concurrentDeletes=await Promise.all([edited.id,secondMapping.id].map(id=>api.DELETE(new Request("http://localhost/api/plex/manual-coverage?id="+id,{method:"DELETE"}))));
  assert.deepEqual(concurrentDeletes.map(response=>response.status),[200,200]);
  assert.deepEqual((await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json()).mappings,[]);
  current=await report();
  assert.deepEqual(current.report.shows.map((show:{missing:unknown[]})=>show.missing.length),[1,1,1],"Concurrent individual deletions withdraw both shows' coverage");
  assert.equal(requests.length,beforeConcurrentDelete);
  assert.deepEqual(showOf(current,12),unrelated);
  assert.equal(current.report.lastScan,initial.report.lastScan);
  assert.deepEqual(withoutMissingIds(current.coverage.issues),[]);
  assert.equal(current.coverage.pending,current.coverage.issues.length ? 1 : 0,"pending reflects only the missing-ID entries");
  edited=(await (await api.POST(request({action:"save",preview:replacement}))).json()).mapping;
  secondMapping=(await (await api.POST(request({action:"save",preview:secondPreview}))).json()).mapping;
  const beforeDelete=requests.length;
  const deleted=await api.DELETE(new Request("http://localhost/api/plex/manual-coverage",{method:"DELETE",body:JSON.stringify({ids:[edited.id,secondMapping.id]})}));assert.equal(deleted.status,200);
  assert.equal(requests.length,beforeDelete,"Bulk cached recheck must perform no HTTP");
  current=await report();
  assert.deepEqual(current.report.shows.map((show:{missing:unknown[]})=>show.missing.length),[1,1,1]);
  assert.deepEqual(current.report.coverageGroups,[]);
  assert.equal(current.report.lastScan,initial.report.lastScan);
  assert.deepEqual(showOf(current,12),unrelated);
  global.__shelfcheckDatabase?.close();delete global.__shelfcheckDatabase;
  assert.deepEqual((await report()).report,current.report);
  await rerun();
  assert.deepEqual(counts(),[2,2,1],"The next explicit scan must download affected shows after restart");
  const lastGood=await report();
  const missingPreview=await preview(12,[300,301]);
  await scan.DELETE(new Request("http://localhost/api/plex/scan?ratingKey=ratingKey%3A12",{method:"DELETE"}));
  const savedWithoutInputs=await api.POST(request({action:"save",preview:missingPreview}));
  assert.equal(savedWithoutInputs.status,201);
  const incomplete=await report();
  assert.deepEqual(incomplete.report.shows,lastGood.report.shows,"Incomplete saved inputs preserve last-good comparisons");
  assert.equal(incomplete.report.lastScan,lastGood.report.lastScan);
  const missingInput = incomplete.coverage.issues.find((issue:{id:string})=>issue.id === "comparison-inputs:ratingKey:12");
  assert.match(missingInput.cause,/Saved show comparison inputs/);
  assert.equal(missingInput.category,undefined);
  assert.match(missingInput.action,/Plex scan.*saved comparison inputs/);
  assert.ok(incomplete.coverage.issues.some((issue:{id:string})=>issue.id==="comparison-inputs:ratingKey:12"));
  assert.ok(incomplete.coverage.issues.some((issue:{id:string})=>issue.id==="comparison-pending"),"The save's show was not compared, so its members stay carried and the comparison pending");
  const repaired=await rerun();
  assert.deepEqual(showOf(repaired,12).missing,[]);
  assert.ok(!repaired.coverage.issues.some((issue:{id:string})=>issue.id==="comparison-inputs:ratingKey:12"));
  assert.ok(!repaired.coverage.issues.some((issue:{id:string})=>issue.id==="comparison-pending"),"The full scan compared it");
  const racePreview=await preview(10,[302]);
  const beforeRace=await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  blockSave=true;
  const saving=api.POST(request({action:"save",preview:racePreview}));
  await saveEntered;
  blockCatalogue=true;
  await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:JSON.stringify({ratingKey:"ratingKey:12"})}));
  releaseSave();
  const rejected=await saving;
  assert.equal(rejected.status,409,"A scan starting during identity validation must reject the mutation");
  assert.equal((await rejected.json()).code,"scan-active");
  const afterRace=await (await api.GET(new Request("http://localhost/api/plex/manual-coverage"))).json();
  assert.equal(afterRace.revision,beforeRace.revision);
  assert.deepEqual(afterRace.mappings,beforeRace.mappings);
  blockCatalogue=false;releaseCatalogue();
  for(let i=0;i<300 && (await report()).scan.status==="running";i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await report()).scan.status,"completed");
  changeFeedUnavailable=true;
  const unverified=await rerun();
  assert.ok(unverified.coverage.issues.some((issue:{id:string})=>issue.id==="provider-verification:TVDB"));
  const afterUnrelatedFailure=await api.POST(request({action:"save",preview:racePreview}));
  assert.equal(afterUnrelatedFailure.status,201);
  const reconciled=await report();
  assert.ok(reconciled.coverage.issues.some((issue:{id:string})=>issue.id==="provider-verification:TVDB"),"A local comparison preserves unrelated freshness issues");
  assert.ok(!reconciled.coverage.issues.some((issue:{id:string})=>issue.id==="comparison-pending"),"Successful local reconciliation retires legacy pending even while other issues remain");
  assert.equal(reconciled.coverage.pending,1);
});

// Owning a TVDB member never covers a TMDB episode, in a cached recheck as in a scan (ADR-0008).
test("a cached recheck after a Manual Match edit covers one way, with no provider HTTP",async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),"cached-one-way-"));
  const beforeData=process.env.SHELFCHECK_DATA_DIR,beforeConfig=process.env.SHELFCHECK_CONFIG_DIR;
  process.env.SHELFCHECK_DATA_DIR=dir;process.env.SHELFCHECK_CONFIG_DIR=dir;
  const global=globalThis as typeof globalThis & {__shelfcheckDatabase?:DatabaseSync};
  t.after(()=>{global.__shelfcheckDatabase?.close();delete global.__shelfcheckDatabase;if(beforeData===undefined)delete process.env.SHELFCHECK_DATA_DIR;else process.env.SHELFCHECK_DATA_DIR=beforeData;if(beforeConfig===undefined)delete process.env.SHELFCHECK_CONFIG_DIR;else process.env.SHELFCHECK_CONFIG_DIR=beforeConfig;rmSync(dir,{recursive:true,force:true});});
  await config.writePlexProviders({plexUrl:"http://plex",plexToken:"test",tmdbToken:"test",tvdbApiKey:"test"});
  ignoreResults.savedScanState("plex").options.patch({ignoredShows:[],diagnosticsEnabled:false});
  // One Plex show known to both providers. Plex owns TMDB 101 and TVDB 202 by identity,
  // in numbers that match neither provider's other episode.
  const requests:string[]=[];
  t.mock.method(globalThis,"fetch",async(input:string|URL|Request)=>{
    const u=new URL(String(input));requests.push(String(u));
    let body:unknown;
    if(u.hostname==="plex"){
      if(u.pathname==="/library/sections")body={MediaContainer:{Directory:[{key:"1",type:"show"}]}};
      else if(u.pathname.includes("/sections/"))body={MediaContainer:{Metadata:[{ratingKey:"show",title:"Show",Guid:[{id:"tmdb://10"},{id:"tvdb://20"}]}]}};
      else if(u.pathname.includes("allLeaves"))body={MediaContainer:{Metadata:[{ratingKey:"a",parentIndex:9,index:1,Guid:[{id:"tmdb://101"}]},{ratingKey:"b",parentIndex:9,index:2,Guid:[{id:"tvdb://202"}]}]}};
      else body={MediaContainer:{Metadata:[{ratingKey:"show",title:"Show",Guid:[{id:"tmdb://10"},{id:"tvdb://20"}]}]}};
    }else if(u.pathname==="/v4/login")body={data:{token:"test"}};
    else if(u.pathname==="/3/tv/10")body={id:10,name:"Show",seasons:[{season_number:1}],external_ids:{tvdb_id:20}};
    else if(u.pathname==="/3/tv/10/season/1")body={episodes:[{id:101,season_number:1,episode_number:1,name:"A",air_date:"2020-01-01"},{id:102,season_number:1,episode_number:2,name:"B",air_date:"2020-01-08"}]};
    else if(u.pathname.match(/^\/3\/tv\/10\/season\/1\/episode\/[12]$/)){const episode=Number(u.pathname.split("/").pop());body={id:100+episode,season_number:1,episode_number:episode,name:episode===1 ? "A" : "B"};}
    else if(u.pathname==="/v4/series/20")body={data:{id:20,name:"Show",slug:"show"}};
    else if(u.pathname==="/v4/series/20/episodes/default")body={data:{episodes:[{id:201,seasonNumber:1,number:1,name:"A",aired:"2020-01-01"},{id:202,seasonNumber:1,number:2,name:"B",aired:"2020-01-08"}]}};
    else if(u.pathname.match(/^\/v4\/episodes\/20[12]\/extended$/)){const episode=Number(u.pathname.split("/")[3]);body={data:{id:episode,seriesId:20,seasonNumber:1,number:episode-200,name:episode===201 ? "A" : "B"}};}
    else if(u.pathname.includes("/find/"))body={tv_results:[],tv_episode_results:[]};
    else if(u.pathname.match(/^\/3\/tv\/10\/season\/1\/episode\/[12]\/external_ids$/))body={};
    else if(u.pathname==="/3/tv/changes")body={results:[],total_pages:1};
    else if(u.pathname==="/v4/updates")body={data:[]};
    else throw new Error("Unexpected HTTP: "+u);
    return Response.json(body);
  });
  const request=(body:unknown)=>new Request("http://localhost/api/plex/manual-coverage",{method:"POST",body:JSON.stringify(body)});
  const report=async()=>(await (await scan.GET()).json());
  const rerun=async()=>{await scan.POST(new Request("http://localhost/api/plex/scan",{method:"POST",body:"{}"}));for(let i=0;i<300;i++){const result=await report();if(result.scan.status!=="running"){assert.equal(result.scan.status,"completed",result.scan.error);return result;}await new Promise(r=>setTimeout(r,10));}throw new Error("scan timeout");};
  const resolve=async(urls:string[])=>{const response=await api.POST(request({action:"resolve",urls}));assert.equal(response.status,200,await response.clone().text());return (await response.json()).preview;};
  const missing=(result:{report:{shows:{missing:{sources:string[];tmdbEpisodeId?:number;tvdbEpisodeId?:number}[]}[]}})=>result.report.shows[0].missing.flatMap(episode=>episode.sources.map(source=>`${source}:${source==="TMDB" ? episode.tmdbEpisodeId : episode.tvdbEpisodeId}`)).sort();
  const initial=await rerun();
  assert.deepEqual(missing(initial),["TMDB:102","TVDB:201"],"Plex owns TMDB 101 and TVDB 202 by identity only");

  // TMDB 101 is owned, so the Manual Match covers its TVDB member 201.
  const saved=(await (await api.POST(request({action:"save",preview:await resolve(["tmdb:101 show:10 season:1 episode:1","tvdb:201"])}))).json()).mapping;
  let current=await report();
  assert.deepEqual(missing(current),["TMDB:102"]);
  assert.deepEqual(current.report.shows[0].manualCoverage.map((item:{mappingId:string;source:{ratingKey:string}[]})=>[item.mappingId,item.source.map(source=>source.ratingKey)]),[[saved.id,["a"]]]);
  assert.equal(current.report.shows[0].coverageOutcomes.find((outcome:{provider:string;id:number})=>outcome.provider==="TVDB" && outcome.id===201).status,"manual");

  // Edited so its TVDB member is the owned TVDB 202 and its TMDB member the unowned TMDB 102:
  // owning TVDB 202 never covers TMDB 102, and TVDB 201 is missing again.
  const preview=await resolve(["tmdb:102 show:10 season:1 episode:2","tvdb:202"]);
  const beforeEdit=requests.length;
  const edit=await api.POST(request({action:"save",id:saved.id,revision:saved.revision,preview}));
  assert.equal(edit.status,200);
  // Saving revalidates only the two reviewed episodes; the recheck enumerates nothing and downloads nothing.
  const recheckRequests=requests.slice(beforeEdit).map(url=>new URL(url)).filter(u=>u.hostname==="plex" || !/^\/(3\/tv\/10\/season\/1\/episode\/2|3\/tv\/10|v4\/episodes\/202\/extended|v4\/series\/20|v4\/login)$/.test(u.pathname));
  assert.deepEqual(recheckRequests.map(String),[],"the cached recheck makes no Plex or provider request");
  current=await report();
  assert.equal(current.scan.status,"completed");
  assert.equal(current.report.lastScan,initial.report.lastScan,"a cached recheck, not a scan");
  assert.deepEqual(missing(current),["TMDB:102","TVDB:201"]);
  assert.equal(current.report.shows[0].manualCoverage,undefined);
  assert.equal(current.report.shows[0].coverageOutcomes.find((outcome:{provider:string;id:number})=>outcome.provider==="TMDB" && outcome.id===102).status,"missing");
  assert.equal(current.report.shows[0].coverageOutcomes.find((outcome:{provider:string;id:number})=>outcome.provider==="TVDB" && outcome.id===202).status,"automatic");
  assert.equal(current.coverage.pending,0);
});
