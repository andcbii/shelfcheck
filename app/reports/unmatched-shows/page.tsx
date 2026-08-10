import { getPlexReport } from "@/lib/plex-scan";
import { UnmatchedShowReport } from "@/app/plex/reports/unmatched-shows/unmatched-show-report";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { ReportTopbar } from "@/app/reports/report-topbar";
import { hasMultipleProviderMatches } from "@/lib/plex-reporting";

export const dynamic = "force-dynamic";

export default function UnmatchedShowsPage() {
  const report = getPlexReport();
  const autoCount = (report?.shows || []).reduce((sum, show) => sum + (show.autoMatches?.length || 0), 0);
  const unmatched = (report?.shows || []).filter((show) => show.providerResolution?.tmdb === false && show.providerResolution.tvdb === false).sort((a, b) => a.title.localeCompare(b.title));
  const providerCount = (report?.shows || []).filter(hasMultipleProviderMatches).length;
  return <main><ReportTopbar /><div className="report-workspace"><ReportSidebar active="unmatched-shows" autoCount={autoCount} unmatchedCount={unmatched.length} providerCount={providerCount} /><section className="report-detail"><div className="auto-match-heading"><div><p className="eyebrow">SHOW LEVEL REPORTING / 02</p><h1>Unmatched Shows</h1></div><p>Shows present in Plex for which neither a TMDB nor TVDB series match could be resolved.</p></div><UnmatchedShowReport shows={unmatched} /></section></div></main>;
}
