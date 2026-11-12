import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { ReportSidebar } from "../app/reports/report-sidebar";
test("all five reports remain navigable with accurate counts including zero Scan Issues",async()=>{
 const browser=new Window();
 browser.document.body.innerHTML=renderToStaticMarkup(createElement(ReportSidebar,{active:"coverage-issues",autoCount:2,unmatchedCount:3,providerCount:4,manualCount:1,issueCount:0}));
 for(const [number,name,path,count] of [["01","Manual Matches","manual-matches",1],["02","Auto Matches","auto-matches",2],["03","Unmatched Shows","unmatched-shows",3],["04","Provider Matches","provider-matches",4],["05","Scan Issues","coverage-issues",0]]) {
  const link=browser.document.querySelector(`a[href="/reports/${path}"]`);
  assert.ok(link,String(name));
  assert.ok(link.textContent.includes(`${number}${name}${count}`),String(name));
 }
 await browser.happyDOM.close();
});
