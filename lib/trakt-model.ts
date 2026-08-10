export type TraktShow = {
  title: string;
  year: number;
  ids: { trakt: number; slug: string; tmdb?: number };
  status?: string;
  images?: { poster?: string[] };
  collection?: { aired: number; completed: number };
  aired_episodes?: number;
  updated_at?: string;
};

export type CollectionShow = {
  show: TraktShow;
  seasons?: { number: number; episodes?: { number: number; collected_at?: string }[] }[];
};

export type MissingEpisode = { show: TraktShow; season: number; episode: number };

export function compactTraktShow(show: TraktShow): TraktShow {
  return {
    title: show.title,
    year: show.year,
    ids: show.ids,
    ...(show.status ? { status: show.status } : {}),
    ...(show.images?.poster?.[0] ? { images: { poster: [show.images.poster[0]] } } : {}),
    ...(show.collection ? { collection: show.collection } : {}),
    ...(Number.isFinite(show.aired_episodes) ? { aired_episodes: show.aired_episodes } : {}),
    ...(show.updated_at ? { updated_at: show.updated_at } : {}),
  };
}

export function compactTraktLibrary(library: CollectionShow[]): CollectionShow[] {
  return library.map(({ show }) => ({ show: compactTraktShow(show) }));
}

export function compactMissingEpisodes(items: MissingEpisode[]): MissingEpisode[] {
  return items.map((item) => ({ ...item, show: compactTraktShow(item.show) }));
}
