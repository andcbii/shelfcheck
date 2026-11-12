import { ManualMatchReport } from "@/app/reports/components/manual-match-report";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { ReportTopbar } from "@/app/reports/report-topbar";
import { coverageState, listCoverageMappings } from "@/lib/manual-coverage";
import { getPlexReport } from "@/lib/plex-scan";
import { hasMultipleProviderMatches } from "@/lib/plex-reporting";
export const dynamic = "force-dynamic";
export default function ManualMatchesPage() {
  const shows = getPlexReport()?.shows || [];
  return <main><ReportTopbar /><div className="report-workspace"><ReportSidebar active="manual-matches" manualCount={listCoverageMappings().length} issueCount={coverageState().issues.length} autoCount={shows.flatMap(show => show.autoMatches || []).length} unmatchedCount={shows.filter(show => show.providerResolution?.tmdb === false && show.providerResolution.tvdb === false).length} providerCount={shows.filter(hasMultipleProviderMatches).length} /><section className="report-detail"><div className="auto-match-heading"><div><p className="eyebrow">EPISODE LEVEL REPORTING / 01</p><h1>Manual Matches</h1></div><p>User-controlled complete episode sets. All saved matches remain available, whether their content is collected, missing, or not owned.</p></div><ManualMatchReport /></section></div></main>;
}
