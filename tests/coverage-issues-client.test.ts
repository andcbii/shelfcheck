import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CoverageIssueReport, CoverageWarning } from "../app/reports/components/coverage-issue-report";
import type { CoverageIssue } from "../lib/coverage-issues";
const issues: CoverageIssue[] = [
  {id:"inventory",scope:"library",provider:"Plex",operation:"inventory",category:"Provider Lookup",lookup:{source:[],requested:{provider:"Plex",kind:"library sections"},status:401,failureKind:"http",impact:"Library inventory could not be verified. Last-good results were retained."},cause:"Library enumeration failed",action:"Check Plex access and run a scan."},
  {id:"freshness",scope:"show",provider:"TMDB",operation:"catalogue-refresh",show:{title:"Unmapped show",tmdbId:10},cause:"Download unavailable",action:"Run New Plex search to retry."},
  {id:"halloween",impacts:["Episode comparison could not be checked because complete provider catalogue inputs are unavailable."],scope:"show",category:"Provider Lookup",provider:"TVDB",operation:"catalogue-refresh",show:{title:"Is It Cake? Halloween",tmdbId:300594,tvdbId:484205},lookup:{source:[{provider:"Plex",kind:"TMDB show",id:300594},{provider:"TMDB",kind:"external TVDB ID",id:484205,cached:true}],requested:{provider:"TVDB",kind:"series",id:484205},status:404,failureKind:"http",impact:"TVDB episode coverage could not be checked. No previous comparison results are available."},cause:"404 — record not found",action:"Check TMDB's external ID reference."},
  {id:"episode",scope:"episode",provider:"TVDB",operation:"episode-resolution",category:"Provider Lookup",lookup:{source:[{provider:"Plex",kind:"TVDB series",id:20},{provider:"TVDB",kind:"catalogue episode",id:200,cached:true}],requested:{provider:"TVDB",kind:"episode",id:200},failureKind:"network",impact:"Episode identity could not be verified."},show:{title:"Example",tvdbId:20},episode:{provider:"TVDB",id:200,season:3,episode:18,title:"Pilot"},cause:"Episode unavailable",action:"Review this episode identity."},
];
test("Scan Issues explain current library and content causes and keep the warning consistent after resolution", async t => {
  const browser = new Window({url:"http://localhost/reports/coverage-issues"});
  const old = new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:browser,self:browser,document:browser.document,HTMLElement:browser.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})) {old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  const container=document.createElement("div"); const root=createRoot(container);
  t.after(async()=>{await act(async()=>root.unmount());await browser.happyDOM.close();for(const [key,value] of old){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
  const render=async(current:CoverageIssue[])=>act(async()=>root.render(createElement("div",null,createElement(CoverageWarning,{issues:current}),createElement(CoverageIssueReport,{issues:current}))));
  await render(issues);
  assert.match(container.textContent!,/4 current issues/);
  assert.match(container.textContent!,/Some scan checks need attention\. Review Scan Issues \(4\) for affected shows, failed lookups, and next steps\./);
  for(const value of ["Provider Lookup","TMDB show 300594","external TVDB ID 484205 (cached)","TVDB series 484205","404 — record not found","No previous comparison results","Source unknown","Episode comparison could not be checked"]) assert.ok(container.textContent!.includes(value),value);
  assert.match(container.querySelector('[aria-label="Library-wide and unassigned issues"]')!.textContent!,/Library enumeration failed/);
  const content=container.querySelector('[aria-label="Show and episode issues"]')!.textContent!;
  for(const value of ["Unmapped show","TMDB 10","catalogue refresh","Download unavailable","Run New Plex search to retry.","TVDB 200","S03E18","Pilot","Review this episode identity."]) assert.ok(content.includes(value),value);
  for(const value of ["Plex library sections","Library inventory could not be verified","TVDB catalogue episode 200 (cached)","TVDB episode 200","Episode identity could not be verified"]) assert.ok(container.textContent!.includes(value),value);
  assert.equal(container.querySelector('a[href="/reports/coverage-issues"]')?.textContent,"Scan Issues (4)");
  await render(issues.slice(0,1));
  assert.match(container.textContent!,/1 current issue/); assert.ok(!container.textContent!.includes("Download unavailable")); assert.ok(container.querySelector('[role="status"]'));
  await render([]);
  assert.match(container.textContent!,/No current Scan Issues/); assert.equal(container.querySelector('[role="status"]'),null);
});

import { CoverageIssuesWorkspace } from "../app/reports/components/coverage-issues-workspace";
test("the report refreshes shared causes and never presents loading failure as verified zero",async t=>{
 const browser=new Window({url:"http://localhost/reports/coverage-issues"});const old=new Map<string,PropertyDescriptor|undefined>(); let fail=true; let current=issues; const requests:string[]=[];
 for(const [key,value] of Object.entries({window:browser,self:browser,document:browser.document,HTMLElement:browser.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,fetch:async(input:unknown,init?:RequestInit)=>{requests.push(`${init?.method || "GET"} ${input}`);return fail?Response.json({error:"Storage unavailable"},{status:503}):Response.json({coverage:{issues:current}});}})){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 const container=document.createElement("div");const root=createRoot(container);
 t.after(async()=>{await act(async()=>root.unmount());await browser.happyDOM.close();for(const [key,value]of old){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 await act(async()=>root.render(createElement(CoverageIssuesWorkspace,{initialIssues:issues,autoCount:0,unmatchedCount:0,providerCount:0,manualCount:0})));
 assert.match(container.querySelector('[role="alert"]')!.textContent!,/Storage unavailable/);assert.ok(!container.textContent!.includes("No current Scan Issues"));
 fail=false;current=[issues[0]];await act(async()=>browser.dispatchEvent(new browser.Event("focus")));
 assert.match(container.textContent!,/1 current issue/);assert.equal(container.querySelector('nav a[href="/reports/coverage-issues"] small')?.textContent,"1");assert.ok(!container.textContent!.includes("Download unavailable"));assert.equal(container.querySelector('[role="alert"]'),null);
 current=[];await act(async()=>browser.dispatchEvent(new browser.Event("focus")));assert.match(container.textContent!,/No current Scan Issues/);
 assert.ok(requests.every(request=>request==="GET /api/plex/scan"),"reading a report never retries provider work or scans");
});
