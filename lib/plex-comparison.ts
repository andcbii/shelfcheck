import { compoundTvdbEvidence, usableTitle, type CompoundCoverage, type CompoundEvidenceFailure, type LocalCompoundEpisode } from "@/lib/compound-episodes";
import { providerEpisodeIsOwned } from "@/lib/plex-episode-outcome";
import { resolvedTmdbMatchEpisode, type TmdbFindEpisode } from "@/lib/plex-auto-match";
import { missingPartsOf, type CoverageEvidence, type CoverageIdentity, type CoverageMapping, type CoverageOutcome } from "@/lib/manual-coverage-model";
import type { PlexAutoMatch, PlexAutoMatchMethod, PlexMissingEpisode, PlexShowResult } from "@/lib/plex-scan";

export type ProviderEpisode = { showTitle?: string; season: number; episode: number; title?: string; airDate?: string; runtime?: number; providerEpisodeId?: number; source: "TMDB" | "TVDB" };
/** Matching methods of the final per-episode decision, in precedence order. */
export type EpisodeCheckMethod = "report-missing" | "coordinates" | "automatic-evidence" | "manual-match" | "missing-result";
/**
 * An Episode-scoped failure (GLOSSARY): one matching check that could not be
 * completed for one provider episode. It grants no coverage; `coveredBy` names the
 * independent method that still established coverage, if any.
 */
export type EpisodeCheckFailure = {
  operation: "compound-matching" | "episode-decision" | "auto-match-record";
  method?: EpisodeCheckMethod;
  episode: { provider?: "TMDB" | "TVDB"; id?: number; season?: number; episode?: number; title?: string };
  kind: CompoundEvidenceFailure["kind"];
  reason: string;
  dependents?: CompoundEvidenceFailure["dependents"];
  local?: CompoundEvidenceFailure["local"];
  coveredBy?: EpisodeCheckMethod;
  /**
   * False when the check still cannot be completed but an earlier method made it
   * unnecessary. It raises no new cause, yet does not resolve an existing one:
   * only repaired evidence or a completed check does.
   */
  required?: false;
};
export type AutomaticEpisodeEvidence ={ method: PlexAutoMatchMethod; tmdbEpisodeId: number; tmdbEpisode?: TmdbFindEpisode };

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
  const episodeFailures: EpisodeCheckFailure[] = [];
  if (autoCompoundEpisodes && tmdbShow && coordinateMissingTvdbIds.size && localTmdbEpisodeIds.size) {
    const { coverage: compoundCovered, failures } = compoundTvdbEvidence(providerEpisodes, localProviderEpisodes);
    // A failed relationship is only a failed check when compound evidence was still
    // needed for one of its episodes; otherwise the check is unnecessary.
    const needed = (id?: number) => Boolean(id && coordinateMissingTvdbIds.has(id) && !locallySatisfiedTvdbIds.has(id));
    for (const failure of failures) {
      const required = failure.kind === "exception" || needed(failure.episode.id) || failure.dependents.some(dependent => needed(dependent.id));
      episodeFailures.push({ operation: "compound-matching", episode: failure.episode, kind: failure.kind, reason: failure.reason, dependents: failure.dependents, local: failure.local, ...(required ? {} : { required: false }) });
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
  const decisions = new Map<string, EpisodeCheckMethod | "reported" | "missing">();
  const identity = (episode: ProviderEpisode) => `${episode.source}:${episode.providerEpisodeId ?? `${episode.season}x${episode.episode}`}`;
  for (const episode of providerEpisodes) {
    const failed: EpisodeCheckFailure[] = [];
    const attempt = <T>(method: EpisodeCheckMethod, run: () => T): T | undefined => {
      try { return run(); }
      catch (error) {
        const failure: EpisodeCheckFailure = { operation: "episode-decision", method, episode: { provider: episode?.source, id: episode?.providerEpisodeId, season: episode?.season, episode: episode?.episode, ...(usableTitle(episode?.title) ? { title: episode.title } : {}) }, kind: "exception", reason: error instanceof Error ? error.message : String(error) };
        failed.push(failure); episodeFailures.push(failure);
        return undefined;
      }
    };
    const collected = (method: EpisodeCheckMethod) => { for (const failure of failed) failure.coveredBy = method; decisions.set(identity(episode), method); };
    const key = `${episode?.season}:${episode?.episode}`;
    // An explicit Report Missing flag precedes every collected determination:
    // coordinates, direct ownership, crosswalks, compound matching and Manual Match coverage.
    // If it cannot be evaluated, no coverage may be granted over a possible flag.
    const precedence = attempt("report-missing", () => {
      const memberMapping = mappings.find(mapping => mapping.members.some(member => member.provider === episode.source && member.id === episode.providerEpisodeId));
      const reported = Boolean(episode.providerEpisodeId && memberMapping?.members.some(member => member.provider === episode.source && member.id === episode.providerEpisodeId && member.reportMissing));
      // A combined episode whose split episodes are reported missing is incomplete,
      // with the same precedence. It is derived from the saved flags, never stored.
      const missingParts = memberMapping && episode.providerEpisodeId && !reported ? missingPartsOf(memberMapping.members, { provider: episode.source, id: episode.providerEpisodeId }) : [];
      if (episode.season === 0 && !reported && !missingParts.length) return { skip: true as const };
      const outcome: CoverageOutcome | undefined = memberMapping && episode.providerEpisodeId ? { provider: episode.source, id: episode.providerEpisodeId, status: "missing", season: episode.season, airDate: episode.airDate } : undefined;
      return { skip: false as const, reported, missingParts, outcome };
    });
    if (precedence?.skip) continue;
    if (!precedence) {
      attempt("missing-result", () => addMissing(key, episode, false));
      decisions.set(identity(episode), "missing");
      continue;
    }
    const { reported, missingParts, outcome } = precedence;
    if (outcome) coverageOutcomes.push(outcome);
    if (reported || missingParts.length) {
      if (reported) outcome!.reportedMissing = true;
      else outcome!.missingParts = missingParts;
      attempt("missing-result", () => addMissing(key, episode, reported, missingParts));
      decisions.set(identity(episode), "reported");
      continue;
    }
    if (attempt("coordinates", () => localEpisodes.has(key))) { if (outcome) outcome.status = "automatic"; collected("coordinates"); continue; }
    if (attempt("automatic-evidence", () => providerEpisodeIsOwned({ source: episode.source, providerEpisodeId: episode.providerEpisodeId, localTmdbEpisodeIds: libraryTmdbEpisodeIds, tvdbEvidence: { directTvdb: Boolean(episode.providerEpisodeId && directTvdbSatisfied.has(episode.providerEpisodeId)), directImdb: Boolean(episode.providerEpisodeId && directImdbSatisfied.has(episode.providerEpisodeId)), trakt: Boolean(episode.providerEpisodeId && traktSatisfied.has(episode.providerEpisodeId)), tmdb: Boolean(episode.providerEpisodeId && tmdbSatisfied.has(episode.providerEpisodeId)), compound: Boolean(episode.providerEpisodeId && compoundSatisfied.has(episode.providerEpisodeId)) }, autoCompoundEpisodes }))) { if (outcome) outcome.status = "automatic"; collected("automatic-evidence"); continue; }
    const manual = attempt("manual-match", () => {
      const mapping = mappings.find(mapping => (!mapping.health || mapping.health === "healthy") && mapping.members.some(member => member.provider === episode.source && member.id === episode.providerEpisodeId));
      if (!mapping) return undefined;
      const sourceMembers = mapping.members.filter(member => member.provider !== episode.source);
      const evidence = manualInventory.filter(item => sourceMembers.some(member => item.identities.some(identity => identity.provider === member.provider && identity.id === member.id)));
      const sourceComplete = sourceMembers.length && sourceMembers.every(member => evidence.some(item => item.identities.some(identity => identity.provider === member.provider && identity.id === member.id)));
      return sourceComplete ? { mapping, evidence } : undefined;
    });
    if (manual) {
      if (outcome) outcome.status = "manual";
      if (!manualCoverage.some(item => item.mappingId === manual.mapping.id)) manualCoverage.push({ mappingId: manual.mapping.id, source: manual.evidence });
      collected("manual-match");
      continue;
    }
    attempt("missing-result", () => addMissing(key, episode, false));
    decisions.set(identity(episode), "missing");
  }
  // Report Missing outranks every other method, so a check it made unnecessary is not a failure.
  // A failed check stays reported when another method established coverage.
  const reportedOrCovered = episodeFailures.filter(failure => {
    if (failure.operation !== "compound-matching" || !failure.episode.id) return true;
    const decision = decisions.get(`${failure.episode.provider}:${failure.episode.id}`);
    if (decision && decision !== "reported" && decision !== "missing") failure.coveredBy = decision;
    return decision !== "reported";
  });
  episodeFailures.splice(0, episodeFailures.length, ...reportedOrCovered);
  const autoMatches: PlexAutoMatch[] = [...autoMatchEvidence].flatMap(([tvdbEpisodeId, evidence]) => {
    const tvdbEpisode = providerEpisodes.find((episode) => episode?.source === "TVDB" && episode.providerEpisodeId === tvdbEpisodeId);
    if (!tvdbEpisode) return [];
    try { return autoMatchRecord(tvdbEpisodeId, tvdbEpisode, evidence); }
    catch (error) {
      episodeFailures.push({ operation: "auto-match-record", episode: { provider: "TVDB", id: tvdbEpisodeId, season: tvdbEpisode.season, episode: tvdbEpisode.episode }, kind: "exception", reason: error instanceof Error ? error.message : String(error) });
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
