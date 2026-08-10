import { ProviderMatchReport } from "@/app/plex/reports/provider-match-report";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { ReportTopbar } from "@/app/reports/report-topbar";
import { getPlexReport } from "@/lib/plex-scan";
import { hasMultipleProviderMatches } from "@/lib/plex-reporting";

export const dynamic = "force-dynamic";

export default function ProviderMatchesPage() {
  const report = getPlexReport();
  const allShows = report?.shows || [];
  const autoCount = allShows.reduce((sum, show) => sum + (show.autoMatches?.length || 0), 0);
  const unmatchedCount = allShows.filter((show) => show.providerResolution?.tmdb === false && show.providerResolution.tvdb === false).length;
  const matches = allShows.filter(hasMultipleProviderMatches).sort((a, b) => a.title.localeCompare(b.title));
  return <main><ReportTopbar /><div className="report-workspace"><ReportSidebar active="provider-matches" autoCount={autoCount} unmatchedCount={unmatchedCount} providerCount={matches.length} /><section className="report-detail"><div className="auto-match-heading"><div><p className="eyebrow">SHOW LEVEL REPORTING / 03</p><h1>Provider Matches</h1></div><p>Plex show identities that resolve to multiple TMDB or TVDB records, or where multiple Plex records converge on one provider identity.</p></div><ProviderMatchReport shows={matches} /></section></div></main>;
}
