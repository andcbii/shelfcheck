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
/** Operations whose impact does not depend on the episode's decision. */
const operationImpacts: Partial<Record<EpisodeCheckFailure["operation"], string>> = {
  "title-recovery": "TVDB's default title for this episode is unusable, so checks that need its title are skipped and grant no coverage; other matching methods were still checked.",
  "auto-match-record": "Auto Match details for this episode are unavailable; its collected status is unchanged.",
};
const crosswalkLabels: Record<EpisodeCrosswalk, string> = {
  IMDb: "IMDb identity crosswalk",
  Trakt: "Trakt episode crosswalk",
  TMDB: "TMDB external ID crosswalk",
};
const episodeCrosswalks = Object.keys(crosswalkLabels) as EpisodeCrosswalk[];
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

/** Every episode-check cause of one show starts with this prefix. */
const showIssuePrefix = (ratingKey: string) => `episode-check:${ratingKey}:`;
/** One check of one show: its operation, decision method and crosswalk, followed by the provider episode. */
const checkIssuePrefix = (ratingKey: string, check: Pick<EpisodeCheckFailure, "operation" | "method" | "crosswalk">) =>
  `${showIssuePrefix(ratingKey)}${check.operation}${check.method ? `:${check.method}` : ""}${check.crosswalk ? `:${check.crosswalk}` : ""}:`;

/** Stable per show, check and provider episode, so a repeated failure updates the same current cause. */
export function episodeCheckIssueId(ratingKey: string, failure: Pick<EpisodeCheckFailure, "operation" | "method" | "crosswalk" | "episode">) {
  const { provider = "Provider", id, season, episode } = failure.episode;
  return `${checkIssuePrefix(ratingKey, failure)}${provider}:${id ?? `${season}x${episode}`}`;
}
/** The current cause of a failed English title request for one TVDB episode. */
export function titleRecoveryIssueId(ratingKey: string, tvdbEpisodeId: number) {
  return episodeCheckIssueId(ratingKey, { operation: "title-recovery", episode: { provider: "TVDB", id: tvdbEpisodeId } });
}
/** The TVDB episodes with a recorded current cause for one check of one show. */
function recordedTvdbEpisodeIds(ratingKey: string, check: Pick<EpisodeCheckFailure, "operation" | "method" | "crosswalk">) {
  return coverageIssueIdsWithPrefix(`${checkIssuePrefix(ratingKey, check)}TVDB:`).flatMap(id => {
    const recorded = getCoverageIssue(id)?.episode?.id;
    return recorded !== undefined ? [recorded] : [];
  });
}
/** The episode crosswalk causes currently recorded for one show, by crosswalk and TVDB episode. */
export function recordedEpisodeCrosswalkFailures(ratingKey: string) {
  return episodeCrosswalks.flatMap(crosswalk => recordedTvdbEpisodeIds(ratingKey, { operation: "episode-crosswalk", crosswalk }).map(tvdbEpisodeId => ({ crosswalk, tvdbEpisodeId })));
}

/** What the episode's decision still established, after this check failed. */
function decisionImpact(failure: EpisodeCheckFailure) {
  if (failure.coveredBy) return `${methodLabels[failure.coveredBy]} established coverage for this episode, so it remains collected; this failed check is still unresolved.`;
  if (failure.notListed === "special") return "No other method established coverage; as a special (season 0) without a readable Report Missing flag, this episode is not listed in missing results.";
  if (failure.notListed === "missing-result-failed") return "No other method established coverage, but its missing result could not be built, so this episode is not listed in missing results.";
  return "No other method established coverage, so this episode remains in missing results.";
}
/** The next step for each kind of failure; `provider` is the provider whose response the check needed. */
const nextSteps: Record<EpisodeCheckFailure["kind"], (failure: EpisodeCheckFailure, provider: string) => string> = {
  "missing-title": failure => `Check this episode's title at ${failure.episode.provider || "the provider"}; the check runs again on the next Plex scan.`,
  "request-failed": (failure, provider) => `Retry the Plex scan after ${provider} availability recovers; ${failure.operation === "title-recovery" ? "its English title is" : "this crosswalk is"} requested again then.`,
  "unreadable-response": (_, provider) => `Run a Plex scan to request this crosswalk again; if ${provider} keeps returning an unreadable response, report it with this issue's details.`,
  "relationship-unavailable": () => "Run a Plex scan to request this crosswalk again; cached rechecks make no provider requests.",
  exception: () => "Run a Plex scan to check this episode again; if the problem continues, report it with this issue's details.",
};

export function episodeCheckIssue(show: EpisodeCheckShow, failure: EpisodeCheckFailure): CoverageIssue {
  const { episode } = failure;
  const label = failure.crosswalk ? crosswalkLabels[failure.crosswalk] : failure.method ? `${operationLabels[failure.operation]} (${methodLabels[failure.method]})` : operationLabels[failure.operation];
  const provider = failure.crosswalk ? crosswalkProviders[failure.crosswalk] : episode.provider;
  const showId = episode.provider === "TVDB" ? show.tvdbId : episode.provider === "TMDB" ? show.tmdbId : undefined;
  const impacts: string[] = [];
  if (failure.operation === "compound-matching" && failure.local) {
    const dependents = failure.dependents?.map(item => `${item.provider} ${item.id} (${numbering(item)})`) || [];
    impacts.push(`Coverage from owned TMDB episode ${failure.local.tmdbEpisodeId ?? "unknown"} (${numbering(failure.local)}) could not be established for this episode${dependents.length ? ` or its related split episodes ${dependents.join(", ")}` : ""}.`);
  }
  if (failure.crosswalk) impacts.push("This crosswalk granted no coverage for this episode; the remaining matching methods were still checked.");
  impacts.push(operationImpacts[failure.operation] ?? decisionImpact(failure));
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
      ...(showId !== undefined ? { showId } : {}),
      ...(episode.season !== undefined ? { season: episode.season } : {}),
      ...(episode.episode !== undefined ? { episode: episode.episode } : {}),
      ...(episode.title ? { title: episode.title } : {}),
    },
    cause: `${label} could not be checked: ${failure.kind === "exception" ? `matching error (${failure.reason}).` : failure.reason}`,
    impacts,
    action: nextSteps[failure.kind](failure, provider || "the provider"),
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
  return `${showIssuePrefix(ratingKey)}catalogue-record:${catalogueRecordKey(record)}`;
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
  const existing = new Set(coverageIssueIdsWithPrefix(showIssuePrefix(show.ratingKey)));
  for (const failure of failures) {
    const issue = episodeCheckIssue(show, failure);
    if (failure.existingOnly && !existing.has(issue.id)) continue;
    if (failure.existingOnly === "carry") {
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
