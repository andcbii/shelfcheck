import { getPlexReport } from "@/lib/plex-scan";
import { coverageState, listCoverageMappings } from "@/lib/manual-coverage";
import { hasMultipleProviderMatches } from "@/lib/plex-reporting";
import { CoverageIssuesWorkspace } from "@/app/reports/components/coverage-issues-workspace";
import { ReportTopbar } from "@/app/reports/report-topbar";

export const dynamic = "force-dynamic";
export default function CoverageIssuesPage(){
  const issues=coverageState().issues;
  const shows=getPlexReport()?.shows || [];
  return <main><ReportTopbar/><CoverageIssuesWorkspace initialIssues={issues} manualCount={listCoverageMappings().length} autoCount={shows.reduce((sum,show)=>sum+(show.autoMatches?.length || 0),0)} unmatchedCount={shows.filter(show=>show.providerResolution?.tmdb === false && show.providerResolution.tvdb === false).length} providerCount={shows.filter(hasMultipleProviderMatches).length}/></main>;
}
