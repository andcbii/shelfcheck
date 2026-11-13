export type CompoundProviderEpisode = {
  season: number;
  episode: number;
  title?: string;
  airDate?: string;
  runtime?: number;
  providerEpisodeId?: number;
  source: "TMDB" | "TVDB";
};

export type LocalCompoundEpisode = {
  season: number;
  episode: number;
  title?: string;
  runtime?: number;
  tmdbEpisodeId?: number;
  tvdbEpisodeId?: number;
  imdbEpisodeId?: string;
};

export type CompoundCoverage = {
  tvdbEpisodeId: number;
  plexSeason: number;
  plexEpisode: number;
  tmdbEpisodeId: number;
  evidence: string[];
};

/**
 * A combined/split relationship that could not be evaluated. Coverage for it is
 * withheld; `episode` is the record whose evidence was unusable and `dependents`
 * the provider episodes whose coverage relied on the same relationship.
 */
export type CompoundEvidenceFailure = {
  episode: { provider: "TMDB" | "TVDB"; id?: number; season: number; episode: number; title?: string };
  dependents: { provider: "TMDB" | "TVDB"; id: number; season: number; episode: number }[];
  local: { season: number; episode: number; tmdbEpisodeId?: number };
  kind: "missing-title" | "exception";
  reason: string;
};

/** Provider and Plex titles are untrusted: null, non-string and blank values are unavailable evidence. */
export function usableTitle(title: unknown): title is string {
  return typeof title === "string" && Boolean(title.trim());
}

function baseTitle(title: string) {
  const normalized = title.toLowerCase()
    .replace(/\(\s*(?:part\s*)?\d+\s*\)/g, " ")
    .replace(/\bpart\s+(?:one|two|three|\d+)\b/g, " ")
    .replace(/\bparts?\s*(?:one|1)\s*(?:and|&|\/)\s*(?:two|2)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const words = normalized.split(" ");
  const midpoint = words.length / 2;
  if (Number.isInteger(midpoint) && words.slice(0, midpoint).join(" ") === words.slice(midpoint).join(" ")) return words.slice(0, midpoint).join(" ");
  return normalized;
}

function consecutive(episodes: CompoundProviderEpisode[]) {
  return episodes.every((episode, index) => index === 0 || episode.episode === episodes[index - 1].episode + 1);
}

function approximately(value: number, expected: number) {
  return Math.abs(value - expected) <= Math.max(4, expected * 0.12);
}

/** Returns auditable TVDB coverage granted by locally-owned, combined TMDB episodes. */
export function compoundTvdbCoverage(episodes: CompoundProviderEpisode[], localEpisodes: LocalCompoundEpisode[]): CompoundCoverage[] {
  return compoundTvdbEvidence(episodes, localEpisodes).coverage;
}

/**
 * Combined/split evidence with episode-scoped failures isolated: a relationship
 * that cannot be evaluated grants no coverage and is reported, while every other
 * owned episode is still evaluated.
 */
export function compoundTvdbEvidence(episodes: CompoundProviderEpisode[], localEpisodes: LocalCompoundEpisode[]): { coverage: CompoundCoverage[]; failures: CompoundEvidenceFailure[] } {
  const coverage: CompoundCoverage[] = [];
  const failures: CompoundEvidenceFailure[] = [];
  const tmdbEpisodes = episodes.filter((episode) => episode?.source === "TMDB");
  const normalRuntimes = tmdbEpisodes.map((episode) => episode.runtime).filter((runtime): runtime is number => Number.isFinite(runtime) && runtime! > 0).sort((a, b) => a - b);
  const typicalRuntime = normalRuntimes.length ? normalRuntimes[Math.floor(normalRuntimes.length / 2)] : undefined;

  for (const local of localEpisodes) {
    try {
      compoundForLocal(local);
    } catch (error) {
      const tmdb = tmdbEpisodes.find((episode) => episode.providerEpisodeId === local.tmdbEpisodeId);
      failures.push({ episode: { provider: "TMDB", id: local.tmdbEpisodeId, season: tmdb?.season ?? local.season, episode: tmdb?.episode ?? local.episode, ...(usableTitle(tmdb?.title) ? { title: tmdb.title } : {}) }, dependents: [], local: { season: local.season, episode: local.episode, tmdbEpisodeId: local.tmdbEpisodeId }, kind: "exception", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { coverage, failures };

  function compoundForLocal(local: LocalCompoundEpisode) {
    if (!local.tmdbEpisodeId || !usableTitle(local.title) || !local.runtime) return;
    const tmdb = tmdbEpisodes.find((episode) => episode.providerEpisodeId === local.tmdbEpisodeId);
    if (!tmdb?.airDate || !usableTitle(tmdb.title) || !tmdb.runtime || tmdb.season !== local.season) return;
    const title = baseTitle(tmdb.title);
    if (!title || baseTitle(local.title) !== title) return;
    const sameDay = episodes.filter((episode) => episode?.source === "TVDB"
      && episode.providerEpisodeId
      && episode.season === tmdb.season
      && episode.airDate === tmdb.airDate);
    const matches = sameDay.filter((episode) => usableTitle(episode.title) && baseTitle(episode.title) === title)
      .sort((a, b) => a.episode - b.episode);
    // Without a title, a same-day TVDB record may or may not be a part of this
    // combined episode. Withhold the whole relationship rather than guess its parts.
    const untitled = sameDay.filter((episode) => !usableTitle(episode.title));
    if (untitled.length) {
      for (const episode of untitled) failures.push({
        episode: { provider: "TVDB", id: episode.providerEpisodeId, season: episode.season, episode: episode.episode },
        dependents: matches.map((match) => ({ provider: "TVDB" as const, id: match.providerEpisodeId!, season: match.season, episode: match.episode })),
        local: { season: local.season, episode: local.episode, tmdbEpisodeId: local.tmdbEpisodeId },
        kind: "missing-title",
        reason: "TVDB returned no usable title for this episode.",
      });
      return;
    }
    if (matches.length < 2 || matches.length > 3 || !consecutive(matches)) return;

    const splitRuntimes = matches.map((episode) => episode.runtime).filter((runtime): runtime is number => Number.isFinite(runtime) && runtime! > 0);
    const splitRuntime = splitRuntimes.reduce((sum, runtime) => sum + runtime, 0);
    const exactRuntime = splitRuntimes.length === matches.length && approximately(local.runtime, splitRuntime);
    const providerRuntime = approximately(local.runtime, tmdb.runtime) && Boolean(typicalRuntime && tmdb.runtime >= typicalRuntime * 1.6);
    if (!exactRuntime && !providerRuntime) return;
    const evidence = ["same-show-season-airdate", "matching-normalized-title", "owned-tmdb-identity", exactRuntime ? "plex-runtime-matches-split-total" : "plex-runtime-matches-double-length-tmdb"];
    for (const match of matches) coverage.push({ tvdbEpisodeId: match.providerEpisodeId!, plexSeason: local.season, plexEpisode: local.episode, tmdbEpisodeId: local.tmdbEpisodeId!, evidence });
  }
}
