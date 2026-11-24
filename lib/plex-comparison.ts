import { compoundTvdbEvidence, episodeReference, type CompoundCoverage, type CompoundEvidenceFailure, type EpisodeReference, type LocalCompoundEpisode } from "@/lib/compound-episodes";
import { coverageIssueCause } from "@/lib/value-guards";
import { providerEpisodeIsOwned } from "@/lib/plex-episode-outcome";
import { resolvedTmdbMatchEpisode, type TmdbFindEpisode } from "@/lib/plex-auto-match";
import { reportedOrIncomplete, type CoverageEvidence, type CoverageIdentity, type CoverageMapping, type CoverageOutcome, type CoverageProvider } from "@/lib/manual-coverage-model";
import { manualMatchCoverageRule, type ManualMatchCoverageRule } from "@/lib/manual-match-coverage";
import type { PlexAutoMatch, PlexAutoMatchMethod, PlexMissingEpisode, PlexShowResult } from "@/lib/plex-scan";

/** `titleLanguage: "eng"`: the default TVDB title was unusable and `title` was recovered from TVDB's English translation. */
export type ProviderEpisode = { showTitle?: string; season: number; episode: number; title?: string; titleLanguage?: "eng"; airDate?: string; runtime?: number; providerEpisodeId?: number; source: CoverageProvider };
/** Matching methods of the final per-episode decision, in precedence order. */
export type EpisodeCheckMethod = "report-missing" | "manual-match" | "coordinates" | "automatic-evidence" | "missing-result";
/**
 * An Episode-scoped failure (GLOSSARY): one matching check that could not be
 * completed for one provider episode. It grants no coverage; `coveredBy` names the
 * independent method that still established coverage, if any.
 */
export type EpisodeCheckFailure = {
  operation: "compound-matching" | "episode-decision" | "auto-match-record" | "episode-crosswalk" | "title-recovery";
  method?: EpisodeCheckMethod;
  /** For `episode-crosswalk`: the identity/crosswalk lookup that failed for this TVDB episode. */
  crosswalk?: EpisodeCrosswalk;
  episode: EpisodeReference;
  /**
   * `request-failed`: the provider request was rejected (its own Provider Lookup cause is in `causedBy`).
   * `unreadable-response`: a successful response could not be interpreted.
   * `relationship-unavailable`: an offline cached recheck has no saved response to replay;
   * no request was attempted.
   */
  kind: CompoundEvidenceFailure["kind"] | "request-failed" | "unreadable-response" | "relationship-unavailable";
  reason: string;
  causedBy?: string[];
  /**
   * Applies only to a cause already recorded; it raises no new one, yet does not resolve it either
   * (only repaired evidence or a completed check does):
   * `refresh`: the check still cannot be completed, but an earlier method made it unnecessary;
   * the recorded cause is updated.
   * `carry`: the failed lookup was not attempted again in this comparison (another method made
   * it unnecessary). Its recorded cause is kept unchanged; only its coverage impact is refreshed.
   */
  existingOnly?: "refresh" | "carry";
  dependents?: CompoundEvidenceFailure["dependents"];
  local?: CompoundEvidenceFailure["local"];
  coveredBy?: EpisodeCheckMethod;
  /**
   * No method established coverage, yet the episode is not listed in missing results:
   * `special`: an unflagged special (season 0), hidden by the normal visibility rule;
   * `missing-result-failed`: its missing result could not be built.
   */
  notListed?: "special" | "missing-result-failed";
};
/** Identity/crosswalk lookups for a TVDB episode, in the order they are tried. */
export type EpisodeCrosswalk = "IMDb" | "Trakt" | "TMDB";
export type AutomaticEpisodeEvidence = { method: PlexAutoMatchMethod; tmdbEpisodeId: number; tmdbEpisode?: TmdbFindEpisode };

/**
 * How one episode's final decision ended: the method that established coverage, reported
 * missing, listed missing, or not listed (an unflagged special, or a missing result that
 * could not be built).
 */
type EpisodeDecision = EpisodeCheckMethod | "reported" | "missing" | NonNullable<EpisodeCheckFailure["notListed"]>;
/** Record on a failed check what the episode's decision still established. */
function describeDecision(failure: EpisodeCheckFailure, decision: EpisodeDecision) {
  if (decision === "special" || decision === "missing-result-failed") failure.notListed = decision;
  else if (decision !== "reported" && decision !== "missing") failure.coveredBy = decision;
}

/** A provider episode's identity in this comparison: provider plus episode ID, or its numbers when it has no ID. */
function identityOf(episode: { source: CoverageProvider; providerEpisodeId?: number; season: number; episode: number }) {
  return `${episode.source}:${episode.providerEpisodeId ?? `${episode.season}x${episode.episode}`}`;
}

/** Inputs loaded by scan orchestration. No inferred or Manual Match coverage is direct inventory. */
export type PlexComparisonInput = {
  ratingKey: string;
  primary: { title?: string };
  tmdbShow: { id: number } | null;
  tvdbId?: number;
  tvdbSlug?: string;
  tmdbSeriesMatches: { id: number; name?: string }[];
  providerEpisodes: ProviderEpisode[];
  localEpisodes: ReadonlySet<string>;
  localProviderEpisodes: LocalCompoundEpisode[];
  localTmdbEpisodeIds: ReadonlySet<number>;
  libraryTmdbEpisodeIds: Set<number>;
  coordinateMissingTvdbIds: ReadonlySet<number>;
  directTvdbSatisfied: ReadonlySet<number>;
  directImdbSatisfied: ReadonlySet<number>;
  traktSatisfied: ReadonlySet<number>;
  tmdbSatisfied: ReadonlySet<number>;
  autoMatchEvidence: ReadonlyMap<number, AutomaticEpisodeEvidence>;
  mappings: CoverageMapping[];
  manualInventory: CoverageEvidence[];
  autoCompoundEpisodes: boolean;
  /**
   * The Manual Match coverage rule evidence gathering already used to leave covered
   * episodes out of automatic work, so the comparison decides from the same rule.
   * Absent, the comparison builds its own from `mappings` and `manualInventory`.
   */
  manualMatchCoverage?: ManualMatchCoverageRule;
  /** Episode-scoped identity/crosswalk failures from evidence gathering before these decisions. */
  crosswalkFailures?: EpisodeCheckFailure[];
  /**
   * The show has a recorded combined/split matching cause. Combined/split evidence is then
   * checked again even when no TVDB coordinates are missing, so the cause is kept until its
   * evidence is repaired and the check completes, not resolved by alternative ownership.
   */
  compoundCausesRecorded?: boolean;
};

/** Compare loaded catalogues and current inventory without HTTP, Plex enumeration, or persistence. */
export function comparePlexShow(input: PlexComparisonInput) {
  const { ratingKey, primary, tmdbShow, tvdbId, tvdbSlug, tmdbSeriesMatches, providerEpisodes,
    localEpisodes, localProviderEpisodes, localTmdbEpisodeIds, libraryTmdbEpisodeIds,
    coordinateMissingTvdbIds, directTvdbSatisfied, directImdbSatisfied, traktSatisfied,
    tmdbSatisfied, mappings, manualInventory, autoCompoundEpisodes } = input;
  const autoMatchEvidence = new Map(input.autoMatchEvidence);
  const locallySatisfiedTvdbIds = new Set([...directTvdbSatisfied, ...directImdbSatisfied, ...traktSatisfied, ...tmdbSatisfied]);
  const compoundSatisfied = new Set<number>();
  const diagnostics: { event: string; data: Record<string, unknown> }[] = [];
  const recordDiagnostic = (event: string, data: Record<string, unknown>) => { diagnostics.push({ event, data }); };
  const compoundCoverage: CompoundCoverage[] = [];
  const episodeFailures: EpisodeCheckFailure[] = [...(input.crosswalkFailures || [])];
  // Built lazily: a Manual Match or evidence record is read only when an episode reaches this check.
  const manualMatchCoverage = input.manualMatchCoverage ?? manualMatchCoverageRule({ mappings, directInventory: manualInventory });
  /**
   * Report Missing (explicit, or a derived Incomplete combined episode) for an episode
   * that is a Manual Match member, and whether an unflagged special is skipped.
   */
  const reportMissingPrecedence = (episode: ProviderEpisode) => {
    const memberMapping = mappings.find(mapping => mapping.members.some(member => member.provider === episode.source && member.id === episode.providerEpisodeId));
    // The episode as a member of a Manual Match, when it is one.
    const mapped = memberMapping && episode.providerEpisodeId ? { members: memberMapping.members, member: { provider: episode.source, id: episode.providerEpisodeId } } : undefined;
    // A combined episode whose split episodes are reported missing is incomplete,
    // with the same precedence. It is derived from the saved flags, never stored.
    const explicitOrDerived = mapped && reportedOrIncomplete(mapped.members, mapped.member);
    const reported = explicitOrDerived?.status === "reported-missing";
    const missingParts = explicitOrDerived?.status === "incomplete" ? explicitOrDerived.missingParts : [];
    if (episode.season === 0 && !reported && !missingParts.length) return { skip: true as const };
    const outcome: CoverageOutcome | undefined = mapped && { ...mapped.member, status: "missing", season: episode.season, airDate: episode.airDate };
    return { skip: false as const, reported, missingParts, outcome };
  };
  const unflagged = (episode: ProviderEpisode | undefined) => ({ skip: episode?.season === 0, reported: false, missingParts: [] as CoverageIdentity[], outcome: undefined });
  /**
   * Whether the final decision below credits the episode to its Manual Match: no Report
   * Missing or derived Incomplete precedes it and the shared rule covers it. A check that
   * fails here counts as not covered; the final decision records that failure.
   */
  const decidedByManualMatch = (episode: ProviderEpisode) => {
    if (episode?.providerEpisodeId === undefined) return false;
    let precedence: { skip: boolean; reported?: boolean; missingParts?: CoverageIdentity[] };
    try { precedence = reportMissingPrecedence(episode); } catch { precedence = unflagged(episode); }
    if (precedence.skip || precedence.reported || precedence.missingParts?.length) return false;
    try { return Boolean(manualMatchCoverage({ provider: episode.source, id: episode.providerEpisodeId })); } catch { return false; }
  };
  if (autoCompoundEpisodes && tmdbShow && ((coordinateMissingTvdbIds.size && localTmdbEpisodeIds.size) || input.compoundCausesRecorded)) {
    // Episodes a Manual Match covers take no part in combined/split matching (ADR-0007),
    // including in the pass forced by recorded compound causes: a covered part never proves
    // coverage for an uncovered sibling, and a covered TMDB record is never the combined side.
    const covered = new Set(providerEpisodes.filter(decidedByManualMatch).map(identityOf));
    const { coverage: compoundCovered, failures } = compoundTvdbEvidence(providerEpisodes, localProviderEpisodes, { excluded: episode => covered.has(identityOf(episode)) });
    // A failed relationship is only a failed check when compound evidence was still
    // needed for one of its episodes; otherwise the check is unnecessary.
    const needed = (id?: number) => Boolean(id && coordinateMissingTvdbIds.has(id) && !locallySatisfiedTvdbIds.has(id));
    for (const failure of failures) {
      const required = failure.kind === "exception" || needed(failure.episode.id) || failure.dependents.some(dependent => needed(dependent.id));
      episodeFailures.push({ operation: "compound-matching", episode: failure.episode, kind: failure.kind, reason: failure.reason, dependents: failure.dependents, local: failure.local, ...(required ? {} : { existingOnly: "refresh" as const }) });
    }
    let reconciled = 0;
    for (const coverage of compoundCovered) if (coordinateMissingTvdbIds.has(coverage.tvdbEpisodeId) && !locallySatisfiedTvdbIds.has(coverage.tvdbEpisodeId)) {
      locallySatisfiedTvdbIds.add(coverage.tvdbEpisodeId);
      compoundSatisfied.add(coverage.tvdbEpisodeId);
      compoundCoverage.push(coverage);
      autoMatchEvidence.set(coverage.tvdbEpisodeId, { method: "Shelfcheck Compound Match", tmdbEpisodeId: coverage.tmdbEpisodeId });
      reconciled += 1;
      recordDiagnostic("plex.show.episode-crosswalk-decision", { ratingKey, tmdbShowId: tmdbShow.id, tvdbShowId: tvdbId, tvdbEpisodeId: coverage.tvdbEpisodeId, plexSeason: coverage.plexSeason, plexEpisode: coverage.plexEpisode, tmdbEpisodeId: coverage.tmdbEpisodeId, evidence: coverage.evidence, outcome: "reconciled-by-auto-compound" });
    }
    recordDiagnostic("plex.show.auto-compound", { ratingKey, enabled: true, candidates: compoundCovered.length, reconciled, failed: episodeFailures.length });
  }
  const manualCoverage: NonNullable<PlexShowResult["manualCoverage"]> = [];
  const missingMap = new Map<string, PlexMissingEpisode>();
  const coverageOutcomes: CoverageOutcome[] = [];
  const addMissing = (key: string, episode: ProviderEpisode, reported: boolean, missingParts: CoverageIdentity[] = []) => {
    let existing = missingMap.get(key);
    if (existing) {
      if (!existing.sources.includes(episode.source)) existing.sources.push(episode.source);
      existing.title ||= episode.title; existing.airDate ||= episode.airDate;
      if (episode.source === "TMDB") existing.tmdbEpisodeId ||= episode.providerEpisodeId;
      if (episode.source === "TVDB") existing.tvdbEpisodeId ||= episode.providerEpisodeId;
      if (reported) existing.reportedMissing = [...new Set([...(existing.reportedMissing || []), episode.source])];
    } else missingMap.set(key, existing = { season: episode.season, episode: episode.episode, title: episode.title, airDate: episode.airDate, ...(episode.source === "TMDB" ? { tmdbEpisodeId: episode.providerEpisodeId } : { tvdbEpisodeId: episode.providerEpisodeId }), sources: [episode.source], ...(reported ? { reportedMissing: [episode.source] } : {}) });
    if (missingParts.length) existing.incomplete = { ...existing.incomplete, [episode.source]: missingParts };
  };
  // Final decisions, isolated per episode and per method. A failed method grants
  // no coverage; later independent methods still run in their existing order.
  const decisions = new Map<string, EpisodeDecision>();
  for (const episode of providerEpisodes) {
    const failed: EpisodeCheckFailure[] = [];
    const attempt = <T>(method: EpisodeCheckMethod, run: () => T): T | undefined => {
      try { return run(); }
      catch (error) {
        const failure: EpisodeCheckFailure = { operation: "episode-decision", method, episode: episodeReference(episode?.source, episode), kind: "exception", reason: coverageIssueCause(error) };
        failed.push(failure); episodeFailures.push(failure);
        return undefined;
      }
    };
    const decide = (decision: EpisodeDecision) => { decisions.set(identityOf(episode), decision); for (const failure of failed) describeDecision(failure, decision); };
    const key = `${episode?.season}:${episode?.episode}`;
    // A reported episode stays "reported" even when its row cannot be built: Report Missing
    // still made the episode's other checks unnecessary.
    const listMissing = (reported: boolean, missingParts?: CoverageIdentity[]) => {
      const listed = attempt("missing-result", () => { addMissing(key, episode, reported, missingParts); return true; });
      decide(reported ? "reported" : listed ? "missing" : "missing-result-failed");
      if (!listed) for (const failure of failed) failure.notListed = "missing-result-failed";
    };
    // An explicit Report Missing flag precedes every collected determination:
    // coordinates, direct ownership, crosswalks, compound matching and Manual Match coverage.
    // If it cannot be evaluated, the episode is treated as unflagged: another valid method
    // still establishes coverage and the season 0 visibility rule still applies.
    const precedence = attempt("report-missing", () => reportMissingPrecedence(episode));
    const { skip, reported, missingParts, outcome } = precedence ?? unflagged(episode);
    if (skip) { decide("special"); continue; }
    if (outcome) coverageOutcomes.push(outcome);
    if (reported || missingParts.length) {
      if (reported) outcome!.reportedMissing = true;
      else outcome!.missingParts = missingParts;
      listMissing(reported, missingParts);
      continue;
    }
    // A covering Manual Match decides the episode right after Report Missing (ADR-0007),
    // ahead of season and episode numbers and automatic evidence. If the check fails,
    // the later independent methods still run.
    const manual = attempt("manual-match", () => episode.providerEpisodeId === undefined ? undefined : manualMatchCoverage({ provider: episode.source, id: episode.providerEpisodeId }));
    if (manual) {
      if (outcome) outcome.status = "manual";
      if (!manualCoverage.some(item => item.mappingId === manual.mapping.id)) manualCoverage.push({ mappingId: manual.mapping.id, source: manual.source });
      decide("manual-match");
      continue;
    }
    if (attempt("coordinates", () => localEpisodes.has(key))) { if (outcome) outcome.status = "automatic"; decide("coordinates"); continue; }
    if (attempt("automatic-evidence", () => providerEpisodeIsOwned({ source: episode.source, providerEpisodeId: episode.providerEpisodeId, localTmdbEpisodeIds: libraryTmdbEpisodeIds, tvdbEvidence: { directTvdb: Boolean(episode.providerEpisodeId && directTvdbSatisfied.has(episode.providerEpisodeId)), directImdb: Boolean(episode.providerEpisodeId && directImdbSatisfied.has(episode.providerEpisodeId)), trakt: Boolean(episode.providerEpisodeId && traktSatisfied.has(episode.providerEpisodeId)), tmdb: Boolean(episode.providerEpisodeId && tmdbSatisfied.has(episode.providerEpisodeId)), compound: Boolean(episode.providerEpisodeId && compoundSatisfied.has(episode.providerEpisodeId)) }, autoCompoundEpisodes }))) { if (outcome) outcome.status = "automatic"; decide("automatic-evidence"); continue; }
    listMissing(false);
  }
  // Report Missing outranks every other method, so a check it made unnecessary is not a failure.
  // A failed check stays reported when another method established coverage.
  const notMadeUnnecessaryByReportMissing = episodeFailures.filter(failure => {
    if ((failure.operation !== "compound-matching" && failure.operation !== "episode-crosswalk") || !failure.episode.id) return true;
    const decision = decisions.get(`${failure.episode.provider}:${failure.episode.id}`);
    if (decision) describeDecision(failure, decision);
    return decision !== "reported";
  });
  episodeFailures.splice(0, episodeFailures.length, ...notMadeUnnecessaryByReportMissing);
  // An episode its Manual Match covers is credited to that match only: automatic evidence
  // for it, including evidence saved by an earlier scan, makes no Auto Match.
  const autoMatches: PlexAutoMatch[] = [...autoMatchEvidence].flatMap(([tvdbEpisodeId, evidence]) => {
    if (decisions.get(`TVDB:${tvdbEpisodeId}`) === "manual-match") return [];
    const tvdbEpisode = providerEpisodes.find((episode) => episode?.source === "TVDB" && episode.providerEpisodeId === tvdbEpisodeId);
    if (!tvdbEpisode) return [];
    try { return autoMatchRecord(tvdbEpisodeId, tvdbEpisode, evidence); }
    catch (error) {
      episodeFailures.push({ operation: "auto-match-record", episode: episodeReference("TVDB", tvdbEpisode), kind: "exception", reason: coverageIssueCause(error) });
      return [];
    }
  }).sort((a, b) => a.tvdb.season - b.tvdb.season || a.tvdb.episode - b.tvdb.episode);

  return { missing: [...missingMap.values()].sort((a, b) => a.season - b.season || a.episode - b.episode),
    coverageOutcomes, autoMatches, compoundCoverage, manualCoverage, diagnostics, episodeFailures };

  function autoMatchRecord(tvdbEpisodeId: number, tvdbEpisode: ProviderEpisode, evidence: AutomaticEpisodeEvidence): PlexAutoMatch[] {
    const tmdbEpisode = providerEpisodes.find((episode) => episode.source === "TMDB" && episode.providerEpisodeId === evidence.tmdbEpisodeId);
    const localTmdbEpisode = localProviderEpisodes.find((episode) => episode.tmdbEpisodeId === evidence.tmdbEpisodeId);
    const matchedTmdbEpisode = evidence.tmdbEpisode;
    const matchedShowId = matchedTmdbEpisode?.show_id ?? tmdbShow?.id;
    const matchedShow = tmdbSeriesMatches.find((show) => show.id === matchedShowId)?.name
      || (matchedShowId === tmdbShow?.id ? tmdbEpisode?.showTitle || primary.title : matchedShowId ? `TMDB series ${matchedShowId}` : primary.title)
      || "Unknown show";
    return [{
      method: evidence.method,
      tmdb: resolvedTmdbMatchEpisode({ tmdbEpisodeId: evidence.tmdbEpisodeId, matched: matchedTmdbEpisode, provider: tmdbEpisode, local: localTmdbEpisode, fallbackShow: primary.title || "Unknown show", fallbackSeason: tvdbEpisode.season, fallbackEpisode: tvdbEpisode.episode, primaryShowId: tmdbShow?.id, matchedShowTitle: matchedShow }),
      tvdb: { id: tvdbEpisodeId, showSlug: tvdbSlug, show: tvdbEpisode.showTitle || primary.title || "Unknown show", name: tvdbEpisode.title, season: tvdbEpisode.season, episode: tvdbEpisode.episode, airDate: tvdbEpisode.airDate, ...(tvdbSlug ? { url: `https://thetvdb.com/series/${encodeURIComponent(tvdbSlug)}/episodes/${tvdbEpisodeId}` } : {}) },
    }];
  }
}
