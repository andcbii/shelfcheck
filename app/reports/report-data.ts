import { coverageState, listCoverageMappings } from "@/lib/manual-coverage";
import { getPlexReport } from "@/lib/plex-scan";
import { readCatalogueSelections } from "@/lib/catalogue-selection-store";
import { multipleProviderIdEntries } from "@/lib/multiple-provider-ids-report";
import { hasMultipleProviderMatches, isUnmatchedShow } from "@/lib/plex-reporting";
import { shownScanIssues } from "@/lib/scan-issues-shown";

// Read the current shared backend state for this request; no report-specific cache.
export function getReportData() {
  const shows = getPlexReport()?.shows || [];
  const allIssues = coverageState().issues;
  const issues = shownScanIssues(allIssues, shows);
  const autoMatches = shows.flatMap(show => show.autoMatches || []).sort((a, b) => a.tvdb.show.localeCompare(b.tvdb.show) || a.tvdb.season - b.tvdb.season || a.tvdb.episode - b.tvdb.episode);
  const unmatchedShows = shows.filter(isUnmatchedShow).sort((a, b) => a.title.localeCompare(b.title));
  const providerMatches = shows.filter(hasMultipleProviderMatches).sort((a, b) => a.title.localeCompare(b.title));
  const multipleIdShows = multipleProviderIdEntries({ selections: readCatalogueSelections(), shows, issues: allIssues });
  return {
    autoMatches,
    unmatchedShows,
    providerMatches,
    multipleIdShows,
    issues,
    counts: {
      manualCount: listCoverageMappings().length,
      issueCount: issues.length,
      autoCount: autoMatches.length,
      unmatchedCount: unmatchedShows.length,
      providerCount: providerMatches.length,
      multipleIdCount: multipleIdShows.length,
    },
  };
}
