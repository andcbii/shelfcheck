import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ManualMatchEditor } from "../app/components/manual-match-editor";

test("Manual Matches offers creation at zero and groups the complete Animaniacs match into one record", async t => {
  const browser = new Window({url:"http://localhost/reports/manual-matches"});
  const previous = new Map<string, PropertyDescriptor | undefined>();
  let mappings: unknown[] = [];
  for (const [key,value] of Object.entries({window:browser,document:browser.document,HTMLElement:browser.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,fetch:async()=>Response.json({mappings,revision:1,pending:0})})) {
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  const container = document.createElement("div"); const root = createRoot(container);
  t.after(async()=>{await act(async()=>root.unmount()); await browser.happyDOM.close(); for(const [key,value] of previous) {if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
  await act(async()=>root.render(createElement(ManualMatchEditor,{key:mappings.length,initialUrls:[],onChanged(){},report:true})));
  assert.equal(container.querySelector('[role="dialog"]'),null);
  assert.match(container.textContent||"",/No Manual Matches/);
  const add = [...container.querySelectorAll("button")].find(button=>button.textContent==="Add Manual Match");
  assert.ok(add); await act(async()=>add.click());
  assert.ok(container.querySelector('[aria-label="Episode URL or provider-qualified ID 1"]'));
  mappings=[{id:"animaniacs",revision:1,health:"healthy",members:[{provider:"TMDB",id:300,showId:107124,show:"Animaniacs",title:"Combined",season:3,episode:18,url:"https://www.themoviedb.org/tv/107124/season/3/episode/18"},...[9623383,9623973].map((id,index)=>({provider:"TVDB",id,showId:386114,show:"Animaniacs",title:`Part ${index+1}`,season:3,episode:18+index,url:`https://thetvdb.com/dereferrer/episode/${id}`}))]}];
  const second=root;
  await act(async()=>second.render(createElement(ManualMatchEditor,{key:mappings.length,initialUrls:[],onChanged(){},report:true})));
  assert.equal(container.querySelectorAll("article").length,1);
  assert.match(container.textContent||"",/Manual Matches \(1\)/);
  assert.match(container.textContent||"",/S03E18/);
  assert.equal(container.querySelectorAll("article a").length,3);
  assert.match(container.textContent||"",/107124/);
  assert.match(container.textContent||"",/9623973/);
  assert.equal(container.querySelectorAll("article .show-provider-matches").length,2);

});


test("Manual Match editor locks an already open form and ownership controls when a Plex scan starts", async t => {
  const browser = new Window({url:"http://localhost/reports/manual-matches"});
  const previous = new Map<string, PropertyDescriptor | undefined>();
  let running = false;
  const member={provider:"TMDB",id:100,showId:10,show:"Target",title:"Combined",season:1,episode:1,url:"https://example.test/100"};
  const mappings=[{id:"healthy",revision:1,members:[member],evidence:[{ratingKey:"item",showKey:"show",fingerprint:"file",identities:[{provider:"TMDB",id:100}]}]},{id:"pending",revision:1,health:"pending",members:[{...member,id:101}]}];
  for (const [key,value] of Object.entries({window:browser,document:browser.document,HTMLElement:browser.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,fetch:async(input: unknown)=>Response.json(String(input) === "/api/plex/scan" ? {scan:{status:running ? "running" : "completed"}} : {mappings,revision:1,pending:0})})) {
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  const container=document.createElement("div"); const root=createRoot(container); const initialUrls=["tmdb:100 show:10 season:1 episode:1","tvdb:200"];
  t.after(async()=>{await act(async()=>root.unmount());await browser.happyDOM.close();for(const[key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
  const render=(scanActive:boolean)=>root.render(createElement(ManualMatchEditor,{initialUrls,onChanged(){},scanActive}));
  await act(async()=>render(false));
  const health=container.querySelector<HTMLSelectElement>('[aria-label="Mapping health"]')!;
  await act(async()=>{health.value="healthy";health.dispatchEvent(new browser.Event("change",{bubbles:true}) as unknown as Event);});
  assert.equal(container.querySelectorAll("article").length,1,"Unset health is Healthy");
  const resolve=[...container.querySelectorAll("button")].find(button=>button.textContent==="Resolve and review")!;
  assert.equal(resolve.disabled,false);
  await act(async()=>{running=true;await new Promise(resolve=>setTimeout(resolve,1100));});
  assert.equal(resolve.disabled,true);
  assert.ok([...container.querySelectorAll<HTMLInputElement>("input")].every(input=>input.disabled));
  assert.ok([...container.querySelectorAll<HTMLButtonElement>("article button")].every(button=>button.disabled));
  assert.match(container.textContent||"",/A Plex scan is running/);
  await act(async()=>{running=false;await new Promise(resolve=>setTimeout(resolve,1100));}); assert.equal(resolve.disabled,false);
});
