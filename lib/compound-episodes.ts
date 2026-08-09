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

function baseTitle(title = "") {
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
  const coverage: CompoundCoverage[] = [];
  const tmdbEpisodes = episodes.filter((episode) => episode.source === "TMDB");
  const normalRuntimes = tmdbEpisodes.map((episode) => episode.runtime).filter((runtime): runtime is number => Number.isFinite(runtime) && runtime! > 0).sort((a, b) => a - b);
  const typicalRuntime = normalRuntimes.length ? normalRuntimes[Math.floor(normalRuntimes.length / 2)] : undefined;

  for (const local of localEpisodes) {
    if (!local.tmdbEpisodeId || !local.title || !local.runtime) continue;
    const tmdb = tmdbEpisodes.find((episode) => episode.providerEpisodeId === local.tmdbEpisodeId);
    if (!tmdb?.airDate || !tmdb.title || !tmdb.runtime || tmdb.season !== local.season) continue;
    const title = baseTitle(tmdb.title);
    if (!title || baseTitle(local.title) !== title) continue;
    const matches = episodes.filter((episode) => episode.source === "TVDB"
      && episode.providerEpisodeId
      && episode.season === tmdb.season
      && episode.airDate === tmdb.airDate
      && baseTitle(episode.title) === title)
      .sort((a, b) => a.episode - b.episode);
    if (matches.length < 2 || matches.length > 3 || !consecutive(matches)) continue;

    const splitRuntimes = matches.map((episode) => episode.runtime).filter((runtime): runtime is number => Number.isFinite(runtime) && runtime! > 0);
    const splitRuntime = splitRuntimes.reduce((sum, runtime) => sum + runtime, 0);
    const exactRuntime = splitRuntimes.length === matches.length && approximately(local.runtime, splitRuntime);
    const providerRuntime = approximately(local.runtime, tmdb.runtime) && Boolean(typicalRuntime && tmdb.runtime >= typicalRuntime * 1.6);
    if (!exactRuntime && !providerRuntime) continue;
    const evidence = ["same-show-season-airdate", "matching-normalized-title", "owned-tmdb-identity", exactRuntime ? "plex-runtime-matches-split-total" : "plex-runtime-matches-double-length-tmdb"];
    for (const match of matches) coverage.push({ tvdbEpisodeId: match.providerEpisodeId!, plexSeason: local.season, plexEpisode: local.episode, tmdbEpisodeId: local.tmdbEpisodeId, evidence });
  }
  return coverage;
}
