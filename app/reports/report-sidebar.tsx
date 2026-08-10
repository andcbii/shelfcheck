"use client";

import Link from "next/link";
import { useState } from "react";

type Props = { active: "all" | "auto-matches" | "unmatched-shows" | "provider-matches"; autoCount: number; unmatchedCount: number; providerCount: number };

export function ReportSidebar({ active, autoCount, unmatchedCount, providerCount }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  return <aside className={`report-sidebar ${collapsed ? "collapsed" : ""}`}>
    <div className="report-sidebar-heading"><span>Report List</span><button type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand report menu" : "Collapse report menu"} title={collapsed ? "Expand" : "Collapse"}>{collapsed ? "→" : "←"}</button></div>
    <nav aria-label="Reports">
      <Link className={active === "all" ? "active" : ""} href="/reports"><b>⌂</b><span>All Reports</span></Link>
      <Link className={active === "auto-matches" ? "active" : ""} href="/reports/auto-matches"><b>01</b><span>Auto Matches</span><small>{autoCount}</small></Link>
      <Link className={active === "unmatched-shows" ? "active" : ""} href="/reports/unmatched-shows"><b>02</b><span>Unmatched Shows</span><small>{unmatchedCount}</small></Link>
      <Link className={active === "provider-matches" ? "active" : ""} href="/reports/provider-matches"><b>03</b><span>Provider Matches</span><small>{providerCount}</small></Link>
    </nav>
  </aside>;
}
