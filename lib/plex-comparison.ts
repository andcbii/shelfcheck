import { compoundTvdbCoverage, type CompoundCoverage, type LocalCompoundEpisode } from "@/lib/compound-episodes";
import { providerEpisodeIsOwned } from "@/lib/plex-episode-outcome";
import { resolvedTmdbMatchEpisode, type TmdbFindEpisode } from "@/lib/plex-auto-match";
import { applyCoverageCorrections } from "@/lib/manual-coverage-inventory";
import type { CoverageCorrection, CoverageEvidence, CoverageMapping, CoverageOutcome } from "@/lib/manual-coverage-model";
import type { PlexAutoMatch, PlexAutoMatchMethod, PlexMissingEpisode, PlexShowResult } from "@/lib/plex-scan";

export type ProviderEpisode = { showTitle?: string; season: number; episode: number; title?: string; airDate?: string; runtime?: number; providerEpisodeId?: number; source: "TMDB" | "TVDB" };
export type AutomaticEpisodeEvidence = { method: PlexAutoMatchMethod; tmdbEpisodeId: number; tmdbEpisode?: TmdbFindEpisode };

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
  corrections: CoverageCorrection[];
  autoCompoundEpisodes: boolean;
};

/** Compare loaded catalogues and current inventory without HTTP, Plex enumeration, or persistence. */
export function comparePlexShow(input: PlexComparisonInput) {
  const { ratingKey, primary, tmdbShow, tvdbId, tvdbSlug, tmdbSeriesMatches, providerEpisodes,
    localEpisodes, localProviderEpisodes, localTmdbEpisodeIds, libraryTmdbEpisodeIds,
    coordinateMissingTvdbIds, directTvdbSatisfied, directImdbSatisfied, traktSatisfied,
    tmdbSatisfied, mappings, manualInventory, corrections, autoCompoundEpisodes } = input;
  const autoMatchEvidence = new Map(input.autoMatchEvidence);
  const locallySatisfiedTvdbIds = new Set([...directTvdbSatisfied, ...directImdbSatisfied, ...traktSatisfied, ...tmdbSatisfied]);
  const compoundSatisfied = new Set<number>();
  const diagnostics: { event: string; data: Record<string, unknown> }[] = [];
  const recordDiagnostic = (event: string, data: Record<string, unknown>) => { diagnostics.push({ event, data }); };
  const compoundCoverage: CompoundCoverage[] = [];
  if (autoCompoundEpisodes && tmdbShow && coordinateMissingTvdbIds.size && localTmdbEpisodeIds.size) {
    const compoundCovered = compoundTvdbCoverage(providerEpisodes, localProviderEpisodes);
    let reconciled = 0;
    for (const coverage of compoundCovered) if (coordinateMissingTvdbIds.has(coverage.tvdbEpisodeId) && !locallySatisfiedTvdbIds.has(coverage.tvdbEpisodeId)) {
      locallySatisfiedTvdbIds.add(coverage.tvdbEpisodeId);
      compoundSatisfied.add(coverage.tvdbEpisodeId);
      compoundCoverage.push(coverage);
      autoMatchEvidence.set(coverage.tvdbEpisodeId, { method: "Shelfcheck Compound Match", tmdbEpisodeId: coverage.tmdbEpisodeId });
      reconciled += 1;
      recordDiagnostic("plex.show.episode-crosswalk-decision", { ratingKey, tmdbShowId: tmdbShow.id, tvdbShowId: tvdbId, tvdbEpisodeId: coverage.tvdbEpisodeId, plexSeason: coverage.plexSeason, plexEpisode: coverage.plexEpisode, tmdbEpisodeId: coverage.tmdbEpisodeId, evidence: coverage.evidence, outcome: "reconciled-by-auto-compound" });
    }
    recordDiagnostic("plex.show.auto-compound", { ratingKey, enabled: true, candidates: compoundCovered.length, reconciled });
  }
  const manualCoverage: NonNullable<PlexShowResult["manualCoverage"]> = [];
  const missingMap = new Map<string, PlexMissingEpisode>();
  const coverageOutcomes: CoverageOutcome[] = [];
  for (const episode of providerEpisodes) {
    if (episode.season === 0) continue;
    const key = `${episode.season}:${episode.episode}`;
    const memberMapping = mappings.find(mapping => mapping.members.some(member => member.provider === episode.source && member.id === episode.providerEpisodeId));
    const outcome = memberMapping && episode.providerEpisodeId ? { provider: episode.source, id: episode.providerEpisodeId, status: "missing" as CoverageOutcome["status"], season: episode.season, airDate: episode.airDate } : undefined;
    if (outcome) coverageOutcomes.push(outcome);
    if (localEpisodes.has(key)) { if (outcome) outcome.status = "automatic"; continue; }
    if (providerEpisodeIsOwned({ source: episode.source, providerEpisodeId: episode.providerEpisodeId, localTmdbEpisodeIds: libraryTmdbEpisodeIds, tvdbEvidence: { directTvdb: Boolean(episode.providerEpisodeId && directTvdbSatisfied.has(episode.providerEpisodeId)), directImdb: Boolean(episode.providerEpisodeId && directImdbSatisfied.has(episode.providerEpisodeId)), trakt: Boolean(episode.providerEpisodeId && traktSatisfied.has(episode.providerEpisodeId)), tmdb: Boolean(episode.providerEpisodeId && tmdbSatisfied.has(episode.providerEpisodeId)), compound: Boolean(episode.providerEpisodeId && compoundSatisfied.has(episode.providerEpisodeId)) }, autoCompoundEpisodes })) { if (outcome) outcome.status = "automatic"; continue; }
    const mapping = mappings.find(mapping => (!mapping.health || mapping.health === "healthy") && mapping.members.some(member => member.provider === episode.source && member.id === episode.providerEpisodeId));
    if (mapping) {
      const sourceMembers = mapping.members.filter(member => member.provider !== episode.source);
      const evidence = applyCoverageCorrections(mapping, manualInventory, corrections).filter(item => sourceMembers.some(member => item.identities.some(identity => identity.provider === member.provider && identity.id === member.id)));
      const sourceComplete = sourceMembers.length && sourceMembers.every(member => evidence.some(item => item.identities.some(identity => identity.provider === member.provider && identity.id === member.id)));
      if (sourceComplete) {
        if (outcome) outcome.status = "manual";
        if (!manualCoverage.some(item => item.mappingId === mapping.id)) manualCoverage.push({ mappingId: mapping.id, source: evidence });
        continue;
      }
    }
    const existing = missingMap.get(key);
    if (existing) {
      if (!existing.sources.includes(episode.source)) existing.sources.push(episode.source);
      existing.title ||= episode.title; existing.airDate ||= episode.airDate;
      if (episode.source === "TMDB") existing.tmdbEpisodeId ||= episode.providerEpisodeId;
      if (episode.source === "TVDB") existing.tvdbEpisodeId ||= episode.providerEpisodeId;
    } else missingMap.set(key, { season: episode.season, episode: episode.episode, title: episode.title, airDate: episode.airDate, ...(episode.source === "TMDB" ? { tmdbEpisodeId: episode.providerEpisodeId } : { tvdbEpisodeId: episode.providerEpisodeId }), sources: [episode.source] });
  }
  const autoMatches: PlexAutoMatch[] = [...autoMatchEvidence].flatMap(([tvdbEpisodeId, evidence]) => {
    const tvdbEpisode = providerEpisodes.find((episode) => episode.source === "TVDB" && episode.providerEpisodeId === tvdbEpisodeId);
    if (!tvdbEpisode) return [];
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
  }).sort((a, b) => a.tvdb.season - b.tvdb.season || a.tvdb.episode - b.tvdb.episode);

  return { missing: [...missingMap.values()].sort((a, b) => a.season - b.season || a.episode - b.episode),
    coverageOutcomes, autoMatches, compoundCoverage, manualCoverage, diagnostics };
}
