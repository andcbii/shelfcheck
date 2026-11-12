import { getReportData } from "@/app/reports/report-data";
import Link from "next/link";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { ReportTopbar } from "@/app/reports/report-topbar";

export const dynamic = "force-dynamic";

export default function ReportsLandingPage() {
  const { counts } = getReportData();
  return <main><ReportTopbar /><div className="report-workspace"><ReportSidebar active="all" {...counts} /><div className="reports-landing-content"><section className="reports-landing-hero"><p className="eyebrow">SHELFCHECK REPORTING</p><h1>Choose a report.</h1><p className="intro">Inspect episode reconciliation and provider resolution outcomes from your latest Plex scan.</p></section><section className="reports-landing-grid"><Link href="/reports/manual-matches"><span>01</span><div><p>Episode level</p><h2>Manual Matches</h2><small>Complete episode relationships set and controlled by you.</small></div><strong>{counts.manualCount}<small>records</small></strong></Link><Link href="/reports/auto-matches"><span>02</span><div><p>Episode level</p><h2>Auto Matches</h2><small>Episodes reconciled through IMDb, Trakt, TMDB external IDs, or Shelfcheck compound matching.</small></div><strong>{counts.autoCount}<small>records</small></strong></Link><Link href="/reports/unmatched-shows"><span>03</span><div><p>Show level</p><h2>Unmatched Shows</h2><small>Plex shows that could not be resolved to either TMDB or TVDB.</small></div><strong>{counts.unmatchedCount}<small>records</small></strong></Link><Link href="/reports/provider-matches"><span>04</span><div><p>Show level</p><h2>Provider Matches</h2><small>Plex identities associated with multiple TMDB or TVDB series, including converging Plex records.</small></div><strong>{counts.providerCount}<small>records</small></strong></Link><Link href="/reports/coverage-issues"><span>05</span><div><p>Coverage verification</p><h2>Scan Issues</h2><small>Current causes preventing episode coverage or provider catalogue freshness verification.</small></div><strong>{counts.issueCount}<small>issues</small></strong></Link></section></div></div></main>;
}
