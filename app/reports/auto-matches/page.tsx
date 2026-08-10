import { getPlexReport, type PlexAutoMatch } from "@/lib/plex-scan";
import { AutoMatchReport } from "@/app/plex/reports/auto-match-report";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { ReportTopbar } from "@/app/reports/report-topbar";
import { hasMultipleProviderMatches } from "@/lib/plex-reporting";

export const dynamic = "force-dynamic";

export default function AutoMatchesPage() {
  const report = getPlexReport();
  const matches = (report?.shows || []).flatMap((show) => show.autoMatches || []).sort((a: PlexAutoMatch, b: PlexAutoMatch) => a.tvdb.show.localeCompare(b.tvdb.show) || a.tvdb.season - b.tvdb.season || a.tvdb.episode - b.tvdb.episode);
  const unmatchedCount = (report?.shows || []).filter((show) => show.providerResolution?.tmdb === false && show.providerResolution.tvdb === false).length;
  const providerCount = (report?.shows || []).filter(hasMultipleProviderMatches).length;
  return <main><ReportTopbar /><div className="report-workspace"><ReportSidebar active="auto-matches" autoCount={matches.length} unmatchedCount={unmatchedCount} providerCount={providerCount} /><section className="report-detail"><div className="auto-match-heading"><div><p className="eyebrow">EPISODE LEVEL REPORTING / 01</p><h1>Auto Matches</h1></div><p>Episodes matched through shared identity or cross-provider evidence rather than an exact Plex TVDB episode ID.</p></div><AutoMatchReport matches={matches} /></section></div></main>;
}
