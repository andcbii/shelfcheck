import "server-only";
import { coverageIssueIdsWithPrefix, getCoverageIssue, resolveCoverageIssue, setCoverageIssue, type CoverageIssue } from "@/lib/coverage-issues";
import type { EpisodeCheckFailure, EpisodeCheckMethod, EpisodeCrosswalk } from "@/lib/plex-comparison";
import { catalogueRecordKey, type MalformedCatalogueRecord } from "@/lib/catalogue-records";

/** The show whose comparison evaluated the episode checks. `ratingKey` is the Plex show identity. */
export type EpisodeCheckShow = { ratingKey: string; title?: string; tmdbId?: number; tvdbId?: number };

const operationLabels: Record<EpisodeCheckFailure["operation"], string> = {
  "compound-matching": "Combined/split episode matching",
  "episode-decision": "Episode coverage decision",
  "auto-match-record": "Auto Match record",
  "episode-crosswalk": "Episode crosswalk",
  "title-recovery": "English title recovery",
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
  if (failure.operation === "title-recovery") impacts.push("TVDB's default title for this episode is unusable, so checks that need its title are skipped and grant no coverage; other matching methods were still checked.");
  else if (failure.operation === "auto-match-record") impacts.push("Auto Match details for this episode are unavailable; its collected status is unchanged.");
  else impacts.push(failure.coveredBy
    ? `${methodLabels[failure.coveredBy]} established coverage for this episode, so it remains collected; this failed check is still unresolved.`
    : failure.notListed === "special"
    ? "No other method established coverage; as a special (season 0) without a readable Report Missing flag, this episode is not listed in missing results."
    : failure.notListed === "missing-result-failed"
    ? "No other method established coverage, but its missing result could not be built, so this episode is not listed in missing results."
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
      ? `Retry the Plex scan after ${provider || "the provider"} availability recovers; ${failure.operation === "title-recovery" ? "its English title is" : "this crosswalk is"} requested again then.`
      : failure.kind === "unreadable-response"
      ? `Run a Plex scan to request this crosswalk again; if ${provider || "the provider"} keeps returning an unreadable response, report it with this Scan Issue.`
      : failure.kind === "relationship-unavailable"
      ? "Run a Plex scan to request this crosswalk again; cached rechecks make no provider requests."
      : "Run a Plex scan to check this episode again; if the problem continues, report it with this Scan Issue.",
  };
}

const catalogueName = (record: MalformedCatalogueRecord) => `${record.provider} ${record.provider === "TMDB" ? "show" : "series"} ${record.showId}`;
const recordProblems: Record<MalformedCatalogueRecord["problem"], string> = {
  "not-a-record": "is not an episode record",
  "no-identity": "has no usable episode ID",
  "no-numbering": "has no usable season and episode numbering",
  "no-identity-or-numbering": "has no usable episode ID or season and episode numbering",
};

/** Stable per show and provider record: its identity, else its numbering, else its response position. */
export function catalogueRecordIssueId(ratingKey: string, record: MalformedCatalogueRecord) {
  return `episode-check:${ratingKey}:catalogue-record:${catalogueRecordKey(record)}`;
}

/**
 * A malformed individual catalogue record. Only fields the provider supplied are
 * reported; without identity or numbering the issue stays at show scope.
 */
export function catalogueRecordIssue(show: EpisodeCheckShow, record: MalformedCatalogueRecord): CoverageIssue {
  const identifiable = record.id !== undefined || record.season !== undefined;
  const impact = record.problem === "no-identity"
    ? "This episode was compared by its season and episode numbering only. Checks that need its provider episode ID (direct ownership, crosswalks, Manual Match and Report Missing) were skipped."
    : record.problem === "no-numbering"
      ? "This episode cannot be compared by numbering: checks that need it were skipped and no missing result was created from this record. If it belongs to a Manual Match, its ID-based checks (Report Missing, direct ownership and Manual Match) still use the numbering saved with that Manual Match. Other episodes were compared normally."
      : "This record was skipped: it was not compared and no missing result was created for it. Other episodes were compared normally.";
  return {
    id: catalogueRecordIssueId(show.ratingKey, record),
    operation: "catalogue-record",
    category: "Provider Catalogue",
    provider: record.provider,
    scope: identifiable ? "episode" : "show",
    show: { ratingKey: show.ratingKey, title: show.title, tmdbId: show.tmdbId, tvdbId: show.tvdbId },
    ...(identifiable ? { episode: {
      provider: record.provider,
      ...(record.id !== undefined ? { id: record.id } : {}),
      showId: record.showId,
      ...(record.season !== undefined ? { season: record.season, episode: record.episode } : {}),
      ...(record.title ? { title: record.title } : {}),
    } } : {}),
    cause: identifiable
      ? `This ${catalogueName(record)} catalogue record ${recordProblems[record.problem]}.`
      : `A ${catalogueName(record)} catalogue record (${record.position}) ${recordProblems[record.problem]}.`,
    impacts: [impact],
    action: `Check this episode's record at ${record.provider}; the catalogue is read again when it is next downloaded.`,
  };
}

/**
 * Publish the current episode-scoped failures of one completed show comparison.
 * Each failed check keeps one current cause; a check that completed in this
 * comparison resolves only its own cause. Other shows' and operations' causes are kept.
 */
export function reconcileEpisodeCheckIssues(show: EpisodeCheckShow, failures: EpisodeCheckFailure[], malformedRecords: MalformedCatalogueRecord[] = []) {
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
  for (const record of malformedRecords) {
    const issue = catalogueRecordIssue(show, record);
    current.add(issue.id);
    setCoverageIssue(issue);
  }
  for (const id of existing) if (!current.has(id)) resolveCoverageIssue(id);
}
