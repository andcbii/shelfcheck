"use client";

import { useEffect, useState } from "react";
import type { CoverageIssue } from "@/lib/coverage-issues";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { CoverageIssueReport } from "./coverage-issue-report";

type Props = {initialIssues: CoverageIssue[]; autoCount: number; unmatchedCount: number; providerCount: number; manualCount: number};
export function CoverageIssuesWorkspace({initialIssues,...counts}: Props) {
  const [issues,setIssues]=useState(initialIssues);
  const [error,setError]=useState("");
  useEffect(()=>{
    let stopped=false, generation=0;
    const load=async()=>{
      const request=++generation;
      try {
        const response=await fetch("/api/plex/scan",{cache:"no-store"});
        const body=await response.json();
        if(!response.ok) throw new Error(body.error || "Scan Issues could not be loaded.");
        if(!Array.isArray(body.coverage?.issues)) throw new Error("Scan Issues could not be verified from the shared scan state.");
        if(!stopped && request===generation){setIssues(body.coverage.issues);setError("");}
      } catch(error){if(!stopped && request===generation)setError(error instanceof Error ? error.message : "Scan Issues could not be loaded.");}
    };
    void load();
    const refresh=()=>{void load();};
    window.addEventListener("focus",refresh);
    const timer=window.setInterval(refresh,5000);
    return ()=>{stopped=true;window.removeEventListener("focus",refresh);window.clearInterval(timer);};
  },[]);
  return <div className="report-workspace"><ReportSidebar active="coverage-issues" {...counts} issueCount={issues.length}/><section className="report-detail"><div className="auto-match-heading"><div><p className="eyebrow">COVERAGE VERIFICATION / 05</p><h1>Scan Issues</h1></div><p>Current causes preventing episode coverage or provider catalogue freshness verification. Follow each cause’s recovery guidance.</p></div>
    {error && <p role="alert" className="plex-warning">{error} Current coverage could not be verified. Previously loaded causes may be out of date.</p>}
    {(!error || issues.length>0) && <CoverageIssueReport issues={issues}/>}
  </section></div>;
}
