import { getReportData } from "@/app/reports/report-data";
import { ProviderMatchReport } from "@/app/reports/components/provider-match-report";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { ReportTopbar } from "@/app/reports/report-topbar";

export const dynamic = "force-dynamic";

export default function ProviderMatchesPage() {
  const { providerMatches: matches, counts } = getReportData();
  return <main><ReportTopbar /><div className="report-workspace"><ReportSidebar active="provider-matches" {...counts} /><section className="report-detail"><div className="auto-match-heading"><div><p className="eyebrow">SHOW LEVEL REPORTING / 04</p><h1>Provider Matches</h1></div><p>Plex show identities that resolve to multiple TMDB or TVDB records, or where multiple Plex records converge on one provider identity.</p></div><ProviderMatchReport shows={matches} /></section></div></main>;
}
