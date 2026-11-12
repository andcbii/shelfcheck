import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CoverageIssueReport, CoverageWarning } from "../app/reports/components/coverage-issue-report";
import type { CoverageIssue } from "../lib/coverage-issues";
const issues: CoverageIssue[] = [
  {id:"inventory",scope:"library",provider:"Plex",operation:"inventory",cause:"Library enumeration failed",action:"Check Plex access and run a scan."},
  {id:"freshness",scope:"show",provider:"TMDB",operation:"catalogue-refresh",show:{title:"Unmapped show",tmdbId:10},cause:"Download unavailable",action:"Run New Plex search to retry."},
  {id:"episode",scope:"episode",provider:"TVDB",operation:"episode-resolution",show:{title:"Example",tvdbId:20},episode:{provider:"TVDB",id:200,season:3,episode:18,title:"Pilot"},cause:"Episode unavailable",action:"Review this episode identity."},
];
test("Coverage Issues explain current library and content causes and keep the warning consistent after resolution", async t => {
  const browser = new Window({url:"http://localhost/reports/coverage-issues"});
  const old = new Map<string,PropertyDescriptor|undefined>();
  for(const [key,value] of Object.entries({window:browser,self:browser,document:browser.document,HTMLElement:browser.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})) {old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  const container=document.createElement("div"); const root=createRoot(container);
  t.after(async()=>{await act(async()=>root.unmount());await browser.happyDOM.close();for(const [key,value] of old){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
  const render=async(current:CoverageIssue[])=>act(async()=>root.render(createElement("div",null,createElement(CoverageWarning,{issues:current}),createElement(CoverageIssueReport,{issues:current}))));
  await render(issues);
  assert.match(container.textContent!,/3 current issues/);
  assert.match(container.querySelector('[aria-label="Library-wide and unassigned issues"]')!.textContent!,/Library enumeration failed/);
  const content=container.querySelector('[aria-label="Show and episode issues"]')!.textContent!;
  for(const value of ["Unmapped show","TMDB 10","catalogue refresh","Download unavailable","Run New Plex search to retry.","TVDB 200","S03E18","Pilot","Review this episode identity."]) assert.ok(content.includes(value),value);
  assert.equal(container.querySelector('a[href="/reports/coverage-issues"]')?.textContent,"View Coverage Issues");
  await render(issues.slice(0,1));
  assert.match(container.textContent!,/1 current issue/); assert.ok(!container.textContent!.includes("Download unavailable")); assert.ok(container.querySelector('[role="status"]'));
  await render([]);
  assert.match(container.textContent!,/No current Coverage Issues/); assert.equal(container.querySelector('[role="status"]'),null);
});

import { CoverageIssuesWorkspace } from "../app/reports/components/coverage-issues-workspace";
test("the report refreshes shared causes and never presents loading failure as verified zero",async t=>{
 const browser=new Window({url:"http://localhost/reports/coverage-issues"});const old=new Map<string,PropertyDescriptor|undefined>(); let fail=true; let current=issues; const requests:string[]=[];
 for(const [key,value] of Object.entries({window:browser,self:browser,document:browser.document,HTMLElement:browser.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,fetch:async(input:unknown,init?:RequestInit)=>{requests.push(`${init?.method || "GET"} ${input}`);return fail?Response.json({error:"Storage unavailable"},{status:503}):Response.json({coverage:{issues:current}});}})){old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 const container=document.createElement("div");const root=createRoot(container);
 t.after(async()=>{await act(async()=>root.unmount());await browser.happyDOM.close();for(const [key,value]of old){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 await act(async()=>root.render(createElement(CoverageIssuesWorkspace,{initialIssues:issues,autoCount:0,unmatchedCount:0,providerCount:0,manualCount:0})));
 assert.match(container.querySelector('[role="alert"]')!.textContent!,/Storage unavailable/);assert.ok(!container.textContent!.includes("No current Coverage Issues"));
 fail=false;current=[issues[0]];await act(async()=>browser.dispatchEvent(new browser.Event("focus")));
 assert.match(container.textContent!,/1 current issue/);assert.ok(!container.textContent!.includes("Download unavailable"));assert.equal(container.querySelector('[role="alert"]'),null);
 current=[];await act(async()=>browser.dispatchEvent(new browser.Event("focus")));assert.match(container.textContent!,/No current Coverage Issues/);
 assert.ok(requests.every(request=>request==="GET /api/plex/scan"),"reading a report never retries provider work or scans");
});
