import { getReportData } from "@/app/reports/report-data";
import { UnmatchedShowReport } from "@/app/reports/components/unmatched-show-report";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { ReportTopbar } from "@/app/reports/report-topbar";

export const dynamic = "force-dynamic";

export default function UnmatchedShowsPage() {
  const { unmatchedShows: unmatched, counts } = getReportData();
  return <main><ReportTopbar /><div className="report-workspace"><ReportSidebar active="unmatched-shows" {...counts} /><section className="report-detail"><div className="auto-match-heading"><div><p className="eyebrow">SHOW LEVEL REPORTING / 03</p><h1>Unmatched Shows</h1></div><p>Shows present in Plex for which neither a TMDB nor TVDB series match could be resolved.</p></div><UnmatchedShowReport shows={unmatched} /></section></div></main>;
}
