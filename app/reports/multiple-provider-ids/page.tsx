import { getReportData } from "@/app/reports/report-data";
import { MultipleProviderIdReportView } from "@/app/reports/components/multiple-provider-id-report-view";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { ReportTopbar } from "@/app/reports/report-topbar";
import { getPlexScanStatus } from "@/lib/plex-scan";

export const dynamic = "force-dynamic";

export default function MultipleProviderIdsPage() {
  const { multipleIdShows, counts } = getReportData();
  return <main><ReportTopbar /><div className="report-workspace"><ReportSidebar active="multiple-provider-ids" {...counts} /><section className="report-detail"><div className="auto-match-heading"><div><p className="eyebrow">SHOW LEVEL REPORTING / 06</p><h1>Multiple Provider IDs</h1></div><p>Scanned Plex shows reporting more than one TMDB or TVDB series. Each provider compares one catalogue: the lowest ID automatically, or the series you choose.</p></div><MultipleProviderIdReportView entries={multipleIdShows} initialScanning={getPlexScanStatus().status === "running"} /></section></div></main>;
}
