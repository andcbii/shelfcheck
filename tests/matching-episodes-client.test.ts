import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ManualCoverageManager } from "../app/components/manual-coverage-manager";

const members = [
  {provider:"TMDB",id:100,showId:10,show:"Target",title:"Combined",season:1,episode:1,url:"https://www.themoviedb.org/tv/10/season/1/episode/1"},
  {provider:"TVDB",id:200,showId:20,show:"Other",title:"Part 1",season:8,episode:8,url:"https://thetvdb.com/series/other/episodes/200"},
  {provider:"TVDB",id:201,showId:20,show:"Other",title:"Part 2",season:8,episode:9,url:"https://thetvdb.com/series/other/episodes/201"},
];
async function mount(t:test.TestContext, initialUrl:string|string[], initialMappings:unknown[] = []) {
  const browser=new Window({url:"http://localhost/plex"});
  let mappings=initialMappings;
  const posts: Record<string,unknown>[]=[];
  const previous=new Map<string,PropertyDescriptor|undefined>();
  let dismissed=0;
  for(const [key,value] of Object.entries({window:browser,document:browser.document,HTMLElement:browser.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,fetch:async(input:unknown,init?:RequestInit)=>{
    if(String(input)==="/api/plex/scan")return Response.json({scan:{status:"completed"}});
    if(init?.method==="POST"){
      const body=JSON.parse(String(init.body)); posts.push(body);
      if(body.action==="resolve")return Response.json({preview:"reviewed",members});
      const mapping={id:"complete",revision:2,members};mappings=[mapping];
      return Response.json({mapping,revision:2});
    }
    return Response.json({mappings,revision:mappings.length?2:0,pending:0});
  }})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  const container=document.createElement("div");const root=createRoot(container);
  const urls=Array.isArray(initialUrl)?initialUrl:[initialUrl];
  const render=()=>root.render(createElement(ManualCoverageManager,{initialUrls:urls,onClose(){dismissed++;root.render(null);},onChanged(){}}));
  t.after(async()=>{await act(async()=>root.unmount());await browser.happyDOM.close();for(const[key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
  await act(async()=>render());
  const click=async(label:string)=>{const button=[...container.querySelectorAll("button")].find(b=>b.textContent===label);assert.ok(button,label);await act(async()=>button.click());};
  return {container,posts,browser,render,click,dismissed:()=>dismissed};
}

test("Matching Episodes opens an unmatched episode without exposing another episode's saved match",async t=>{
 const ui=await mount(t,"tvdb:999",[{id:"unrelated",revision:1,members}]);
 assert.match(ui.container.querySelector('[role="dialog"]')?.textContent||"",/Matching Episodes/);
 assert.deepEqual([...ui.container.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')].map(i=>i.value),["tvdb:999",""]);
 assert.equal(ui.container.querySelectorAll("article").length,0);
 assert.doesNotMatch(ui.container.textContent||"",/Saved mappings|Mapping health|unrelated|Combined/);
});
for(const selected of ["tmdb:100 show:10 season:1 episode:1","http://themoviedb.org/tv/10-target/season/1/episode/1/?language=en-US","tvdb:201","https://www.thetvdb.com/series/renamed/episodes/200/?lang=en","https://thetvdb.com/dereferrer/episode/201"]){
 test(`Matching Episodes loads every member by provider episode identity: ${selected}`,async t=>{
  const ui=await mount(t,selected,[{id:"complete",revision:2,members},{id:"unrelated",revision:2,members:[{...members[0],id:101,episode:2,title:"UNRELATED"}]}]);
  assert.deepEqual([...ui.container.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')].map(i=>i.value),members.map(m=>m.url));
  assert.equal(ui.container.querySelectorAll("article").length,1);
  assert.match(ui.container.querySelector("article")?.textContent||"",/Part 2/);
  assert.doesNotMatch(ui.container.textContent||"",/UNRELATED/);
 });
}

test("Matching Episodes stays open after saving and retains the saved complete match for another edit",async t=>{
 const ui=await mount(t,["tmdb:100 show:10 season:1 episode:1","tvdb:200"]);
 await ui.click("Resolve and review");await ui.click("Save coverage mapping");
 assert.ok(ui.container.querySelector('[role="dialog"]'));
 assert.equal(ui.container.querySelectorAll("article").length,1);
 assert.match(ui.container.textContent||"",/Editing mapping complete/);
 await ui.click("Resolve and review");await ui.click("Save coverage mapping");
 assert.equal(ui.posts.at(-1)?.id,"complete");assert.equal(ui.posts.at(-1)?.revision,2);
});
for(const dismissal of ["Close","backdrop"]){
 test(`Matching Episodes ${dismissal} discards drafts without saving and inside clicks stay open`,async t=>{
  const ui=await mount(t,"tvdb:999");
  await ui.click("Add episode");
  assert.equal(ui.container.querySelectorAll('input:not([type="checkbox"])').length,3);
  await act(async()=>ui.container.querySelector<HTMLElement>('[role="dialog"]')!.click());
  assert.equal(ui.dismissed(),0);
  if(dismissal==="Close")await ui.click("Close");
  else await act(async()=>ui.container.querySelector<HTMLElement>('.modal-backdrop')!.click());
  assert.equal(ui.dismissed(),1);assert.deepEqual(ui.posts,[]);
  await act(async()=>ui.render());
  assert.deepEqual([...ui.container.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')].map(i=>i.value),["tvdb:999",""]);
 });
}
