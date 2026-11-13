import "server-only";
import { coverageIssueIdsWithPrefix, getCoverageIssue, resolveCoverageIssue, setCoverageIssue, type CoverageIssue } from "@/lib/coverage-issues";
import type { EpisodeCheckFailure, EpisodeCheckMethod, EpisodeCrosswalk } from "@/lib/plex-comparison";

/** The show whose comparison evaluated the episode checks. `ratingKey` is the Plex show identity. */
export type EpisodeCheckShow = { ratingKey: string; title?: string; tmdbId?: number; tvdbId?: number };

const operationLabels: Record<EpisodeCheckFailure["operation"], string> = {
  "compound-matching": "Combined/split episode matching",
  "episode-decision": "Episode coverage decision",
  "auto-match-record": "Auto Match record",
  "episode-crosswalk": "Episode crosswalk",
};
const crosswalkLabels: Record<EpisodeCrosswalk, string> = {
  IMDb: "IMDb identity crosswalk",
  Trakt: "Trakt episode crosswalk",
  TMDB: "TMDB external ID crosswalk",
};
/** The provider whose response the crosswalk interprets (TVDB supplies an episode's IMDb IDs). */
const crosswalkProviders: Record<EpisodeCrosswalk, "TVDB" | "Trakt" | "TMDB"> = { IMDb: "TVDB", Trakt: "Trakt", TMDB: "TMDB" };
const methodLabels: Record<EpisodeCheckMethod, string> = {
  "report-missing": "Report Missing",
  coordinates: "Plex season and episode numbering",
  "automatic-evidence": "Automatic provider evidence",
  "manual-match": "A complete-set Manual Match",
  "missing-result": "Missing result",
};
const numbering = (item: { season?: number; episode?: number }) => item.season !== undefined && item.episode !== undefined ? `S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}` : "unknown numbering";

/** Stable per show, check and provider episode, so a repeated failure updates the same current cause. */
export function episodeCheckIssueId(ratingKey: string, failure: EpisodeCheckFailure) {
  const { provider = "Provider", id, season, episode } = failure.episode;
  return `episode-check:${ratingKey}:${failure.operation}${failure.method ? `:${failure.method}` : ""}${failure.crosswalk ? `:${failure.crosswalk}` : ""}:${provider}:${id ?? `${season}x${episode}`}`;
}
/** The episode crosswalk causes currently recorded for one show, by crosswalk and TVDB episode. */
export function recordedEpisodeCrosswalkFailures(ratingKey: string) {
  return coverageIssueIdsWithPrefix(`episode-check:${ratingKey}:episode-crosswalk:`).flatMap(id => {
    const match = id.match(/:(IMDb|Trakt|TMDB):TVDB:(\d+)$/);
    return match ? [{ crosswalk: match[1] as EpisodeCrosswalk, tvdbEpisodeId: Number(match[2]) }] : [];
  });
}

export function episodeCheckIssue(show: EpisodeCheckShow, failure: EpisodeCheckFailure): CoverageIssue {
  const { episode } = failure;
  const label = failure.crosswalk ? crosswalkLabels[failure.crosswalk] : failure.method ? `${operationLabels[failure.operation]} (${methodLabels[failure.method]})` : operationLabels[failure.operation];
  const provider = failure.crosswalk ? crosswalkProviders[failure.crosswalk] : episode.provider;
  const impacts: string[] = [];
  if (failure.operation === "compound-matching" && failure.local) {
    const dependents = failure.dependents?.map(item => `${item.provider} ${item.id} (${numbering(item)})`) || [];
    impacts.push(`Coverage from owned TMDB episode ${failure.local.tmdbEpisodeId ?? "unknown"} (${numbering(failure.local)}) could not be established for this episode${dependents.length ? ` or its related split episodes ${dependents.join(", ")}` : ""}.`);
  }
  if (failure.crosswalk) impacts.push("This crosswalk granted no coverage for this episode; the remaining matching methods were still checked.");
  if (failure.operation === "auto-match-record") impacts.push("Auto Match details for this episode are unavailable; its collected status is unchanged.");
  else impacts.push(failure.coveredBy
    ? `${methodLabels[failure.coveredBy]} established coverage for this episode, so it remains collected; this failed check is still unresolved.`
    : "No other method established coverage, so this episode remains in missing results.");
  return {
    id: episodeCheckIssueId(show.ratingKey, failure),
    operation: failure.operation,
    category: "Episode Matching",
    ...(provider ? { provider } : {}),
    scope: "episode",
    ...(failure.causedBy?.length ? { causedBy: failure.causedBy } : {}),
    show: { ratingKey: show.ratingKey, title: show.title, tmdbId: show.tmdbId, tvdbId: show.tvdbId },
    episode: {
      ...(episode.provider ? { provider: episode.provider } : {}),
      ...(episode.id !== undefined ? { id: episode.id } : {}),
      ...((episode.provider === "TVDB" ? show.tvdbId : episode.provider === "TMDB" ? show.tmdbId : undefined) !== undefined ? { showId: episode.provider === "TVDB" ? show.tvdbId : show.tmdbId } : {}),
      ...(episode.season !== undefined ? { season: episode.season } : {}),
      ...(episode.episode !== undefined ? { episode: episode.episode } : {}),
      ...(episode.title ? { title: episode.title } : {}),
    },
    cause: `${label} could not be checked: ${failure.kind === "exception" ? `matching error (${failure.reason}).` : failure.reason}`,
    impacts,
    action: failure.kind === "missing-title"
      ? `Check this episode's title at ${episode.provider || "the provider"}; the check runs again on the next Plex scan.`
      : failure.kind === "request-failed"
      ? `Retry the Plex scan after ${provider || "the provider"} availability recovers; this crosswalk is requested again then.`
      : failure.kind === "unreadable-response"
      ? `Run a Plex scan to request this crosswalk again; if ${provider || "the provider"} keeps returning an unreadable response, report it with this Scan Issue.`
      : "Run a Plex scan to check this episode again; if the problem continues, report it with this Scan Issue.",
  };
}

/**
 * Publish the current episode-scoped failures of one completed show comparison.
 * Each failed check keeps one current cause; a check that completed in this
 * comparison resolves only its own cause. Other shows' and operations' causes are kept.
 */
export function reconcileEpisodeCheckIssues(show: EpisodeCheckShow, failures: EpisodeCheckFailure[]) {
  const current = new Set<string>();
  const existing = new Set(coverageIssueIdsWithPrefix(`episode-check:${show.ratingKey}:`));
  for (const failure of failures) {
    const issue = episodeCheckIssue(show, failure);
    if ((failure.required === false || failure.carried) && !existing.has(issue.id)) continue;
    if (failure.carried) {
      // Not looked up again: keep the recorded cause, refresh only what now covers the episode.
      current.add(issue.id);
      const recorded = getCoverageIssue(issue.id);
      if (recorded) setCoverageIssue({ ...recorded, impacts: issue.impacts });
      continue;
    }
    current.add(issue.id);
    setCoverageIssue(issue);
  }
  for (const id of existing) if (!current.has(id)) resolveCoverageIssue(id);
}
