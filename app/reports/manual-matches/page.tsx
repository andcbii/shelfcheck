import { getReportData } from "@/app/reports/report-data";
import { ManualMatchReport } from "@/app/reports/components/manual-match-report";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { ReportTopbar } from "@/app/reports/report-topbar";
export const dynamic = "force-dynamic";
export default function ManualMatchesPage() {
  const { counts } = getReportData();
  return <main><ReportTopbar /><div className="report-workspace"><ReportSidebar active="manual-matches" {...counts} /><section className="report-detail"><div className="auto-match-heading"><div><p className="eyebrow">EPISODE LEVEL REPORTING / 01</p><h1>Manual Matches</h1></div><p>User-controlled complete episode sets. All saved matches remain available, whether their content is collected, missing, or not owned.</p></div><ManualMatchReport /></section></div></main>;
}
