import { getReportData } from "@/app/reports/report-data";
import { AutoMatchReport } from "@/app/reports/components/auto-match-report";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { ReportTopbar } from "@/app/reports/report-topbar";

export const dynamic = "force-dynamic";

export default function AutoMatchesPage() {
  const { autoMatches: matches, counts } = getReportData();
  return <main><ReportTopbar /><div className="report-workspace"><ReportSidebar active="auto-matches" {...counts} /><section className="report-detail"><div className="auto-match-heading"><div><p className="eyebrow">EPISODE LEVEL REPORTING / 02</p><h1>Auto Matches</h1></div><p>Episodes matched through shared identity or cross-provider evidence rather than an exact Plex TVDB episode ID.</p></div><AutoMatchReport matches={matches} /></section></div></main>;
}
