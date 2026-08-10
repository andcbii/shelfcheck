import Link from "next/link";
import { getPlexReport } from "@/lib/plex-scan";
import { ReportSidebar } from "@/app/reports/report-sidebar";
import { ReportTopbar } from "@/app/reports/report-topbar";
import { hasMultipleProviderMatches } from "@/lib/plex-reporting";

export const dynamic = "force-dynamic";

export default function ReportsLandingPage() {
  const report = getPlexReport();
  const autoCount = (report?.shows || []).reduce((sum, show) => sum + (show.autoMatches?.length || 0), 0);
  const unmatchedCount = (report?.shows || []).filter((show) => show.providerResolution?.tmdb === false && show.providerResolution.tvdb === false).length;
  const providerCount = (report?.shows || []).filter(hasMultipleProviderMatches).length;
  return <main><ReportTopbar /><div className="report-workspace"><ReportSidebar active="all" autoCount={autoCount} unmatchedCount={unmatchedCount} providerCount={providerCount} /><div className="reports-landing-content"><section className="reports-landing-hero"><p className="eyebrow">SHELFCHECK REPORTING</p><h1>Choose a report.</h1><p className="intro">Inspect episode reconciliation and provider resolution outcomes from your latest Plex scan.</p></section><section className="reports-landing-grid"><Link href="/reports/auto-matches"><span>01</span><div><p>Episode level</p><h2>Auto Matches</h2><small>Episodes reconciled through IMDb, Trakt, TMDB external IDs, or Shelfcheck compound matching.</small></div><strong>{autoCount}<small>records</small></strong></Link><Link href="/reports/unmatched-shows"><span>02</span><div><p>Show level</p><h2>Unmatched Shows</h2><small>Plex shows that could not be resolved to either TMDB or TVDB.</small></div><strong>{unmatchedCount}<small>records</small></strong></Link><Link href="/reports/provider-matches"><span>03</span><div><p>Show level</p><h2>Provider Matches</h2><small>Plex identities associated with multiple TMDB or TVDB series, including converging Plex records.</small></div><strong>{providerCount}<small>records</small></strong></Link></section></div></div></main>;
}
