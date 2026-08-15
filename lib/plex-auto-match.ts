export type AutoMatchEpisodeRecord = { id?: number; showId?: number; show: string; name?: string; season: number; episode: number; airDate?: string; url?: string };
export type TmdbFindEpisode = { id?: number; show_id?: number; season_number?: number; episode_number?: number; name?: string; air_date?: string | null };
type EpisodeFallback = { showTitle?: string; title?: string; season?: number; episode?: number; airDate?: string };

export function resolvedTmdbMatchEpisode(input: {
  tmdbEpisodeId: number;
  matched?: TmdbFindEpisode;
  provider?: EpisodeFallback;
  local?: EpisodeFallback;
  fallbackShow: string;
  fallbackSeason: number;
  fallbackEpisode: number;
  primaryShowId?: number;
  matchedShowTitle?: string;
}): AutoMatchEpisodeRecord {
  const showId = input.matched?.show_id ?? input.primaryShowId;
  const season = input.matched?.season_number ?? input.provider?.season ?? input.local?.season ?? input.fallbackSeason;
  const episode = input.matched?.episode_number ?? input.provider?.episode ?? input.local?.episode ?? input.fallbackEpisode;
  return {
    id: input.tmdbEpisodeId,
    showId,
    show: input.matchedShowTitle || input.provider?.showTitle || input.fallbackShow,
    name: input.matched?.name || input.provider?.title || input.local?.title,
    season,
    episode,
    airDate: input.matched?.air_date || input.provider?.airDate,
    ...(showId ? { url: `https://www.themoviedb.org/tv/${showId}/season/${season}/episode/${episode}` } : {}),
  };
}
