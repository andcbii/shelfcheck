import { isAllowedPlexThumbPath } from "./plex-poster";
import { positiveId } from "./value-guards";

/**
 * One show of the last saved Plex report, reduced to what matching a Trakt show to
 * its Plex artwork needs: its show GUIDs, TMDB and TVDB IDs and an allowed
 * thumbnail path. ratingKey is the stable tie-break between duplicate candidates.
 */
export type PlexArtworkEntry = { ratingKey: string; plexGuids: string[]; tmdbId?: number; tvdbId?: number; thumb?: string };

/** The IDs a saved Trakt show may carry; older reports lack tvdb and plex. */
export type TraktArtworkIds = { tmdb?: unknown; tvdb?: unknown; plex?: { guid?: unknown } | null };

// The scan keeps any plex://show/ GUID; Trakt stores the identifier after the prefix.
const PLEX_SHOW_GUID = /^(?:plex:\/\/show\/)?([0-9a-z]+)$/i;

/**
 * A Plex show GUID in Plex's prefixed form, from either that form or the bare
 * identifier Trakt stores; null for anything else.
 */
export function plexShowGuid(value: unknown): string | null {
  const match = typeof value === "string" ? PLEX_SHOW_GUID.exec(value.trim()) : null;
  return match ? `plex://show/${match[1].toLowerCase()}` : null;
}

function usableThumb(value: unknown): string | null {
  return typeof value === "string" && isAllowedPlexThumbPath(value) ? value : null;
}

/** The artwork index of a saved Plex report; empty when there is none. */
export function plexArtworkIndex(report: { shows?: unknown } | null | undefined): PlexArtworkEntry[] {
  if (!Array.isArray(report?.shows)) return [];
  return report.shows.flatMap((show: Record<string, unknown> | null) => {
    if (!show || typeof show.ratingKey !== "string") return [];
    const guids = [show.plexGuid, ...(Array.isArray(show.plexGuids) ? show.plexGuids : [])].map(plexShowGuid).filter((guid): guid is string => guid !== null);
    const tmdbId = positiveId(show.tmdbId);
    const tvdbId = positiveId(show.tvdbId);
    const thumb = usableThumb(show.thumb);
    return [{ ratingKey: show.ratingKey, plexGuids: [...new Set(guids)], ...(tmdbId ? { tmdbId } : {}), ...(tvdbId ? { tvdbId } : {}), ...(thumb ? { thumb } : {}) }];
  });
}

const byRatingKey = (a: PlexArtworkEntry, b: PlexArtworkEntry) => a.ratingKey.localeCompare(b.ratingKey, "en", { numeric: true });

/**
 * Matches Trakt shows to Plex artwork from an index: by Plex GUID, then TMDB ID,
 * then TVDB ID. The first level with a candidate decides, so a show never borrows
 * another show's artwork through a weaker ID; it gets null when that candidate
 * has no usable thumbnail. Among duplicates the candidate with a thumbnail and the
 * lowest ratingKey wins, whatever the index order. Returns the thumbnail path.
 */
export function plexArtworkMatcher(index: readonly unknown[]): (ids: TraktArtworkIds | null | undefined) => string | null {
  // The index arrives over the network, so it is cleaned again before use.
  const entries = plexArtworkIndex({ shows: index }).sort(byRatingKey);
  const best = new Map<string, PlexArtworkEntry>();
  const offer = (key: string, entry: PlexArtworkEntry) => {
    const current = best.get(key);
    if (!current || (!current.thumb && entry.thumb)) best.set(key, entry);
  };
  for (const entry of entries) {
    for (const guid of entry.plexGuids) offer(`guid:${guid}`, entry);
    if (entry.tmdbId) offer(`tmdb:${entry.tmdbId}`, entry);
    if (entry.tvdbId) offer(`tvdb:${entry.tvdbId}`, entry);
  }
  return (ids) => {
    const guid = plexShowGuid(ids?.plex?.guid);
    const tmdb = positiveId(ids?.tmdb);
    const tvdb = positiveId(ids?.tvdb);
    const keys = [guid && `guid:${guid}`, tmdb && `tmdb:${tmdb}`, tvdb && `tvdb:${tvdb}`];
    for (const key of keys) {
      const match = key ? best.get(key) : undefined;
      if (match) return match.thumb ?? null;
    }
    return null;
  };
}
