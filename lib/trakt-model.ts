import { localCalendarDate, type CalendarDate } from "./results-view";

export type TraktShow = {
  title: string;
  year: number;
  /** Trakt's IDs as saved; older reports may lack tvdb and plex, and Trakt sends null for unknown ones. */
  ids: { trakt: number; slug: string; tmdb?: number; tvdb?: number | null; plex?: { guid?: string | null; slug?: string | null } | null };
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

/**
 * A missing episode Trakt's collection progress reported. `firstAired` is Trakt's
 * original first_aired timestamp (UTC), when Trakt gave a usable one; the page
 * converts it to the browser's local calendar date.
 */
export type MissingEpisode = { show: TraktShow; season: number; episode: number; firstAired?: string };

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

/**
 * A Trakt first_aired timestamp as the runtime's local calendar date (the
 * browser's, on the page). Trakt's timestamps are UTC instants, so a broadcast
 * late in the UTC day can fall on another local date. Undefined when missing or
 * unreadable.
 */
export function traktLocalAirDate(firstAired: string | undefined): CalendarDate | undefined {
  if (!firstAired) return undefined;
  const moment = new Date(firstAired);
  return Number.isNaN(moment.getTime()) ? undefined : localCalendarDate(moment);
}
