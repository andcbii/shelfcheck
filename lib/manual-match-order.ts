import type { CoverageMapping, CoverageMember, CoverageProvider } from "@/lib/manual-coverage-model";

/** A provider show as the Manual Matches report names it. */
export type OrderedShow = { show: string; showYear?: number; showId: number };

/**
 * The report's show order: show name A-Z, then Show year ascending with no
 * known year last, then show ID. Cards and show filter options both use it.
 */
export function compareShows(a: OrderedShow, b: OrderedShow) {
  return a.show.localeCompare(b.show)
    || (a.showYear ?? Infinity) - (b.showYear ?? Infinity)
    || a.showId - b.showId;
}

/** Orders by Manual Match ID. */
export const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// Oldest-created first (ties: lower Manual Match ID), so the newest match is read last and wins.
// Creation time decides which saved name a show takes; edits and revisions never do.
const oldestFirst = (a: CoverageMapping, b: CoverageMapping) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || byId(a, b);

/**
 * Each show ID on `provider`'s side of the saved Manual Matches, with the name
 * and Show year of the most recently created match holding it (ties: the
 * higher Manual Match ID). The report names, labels and orders a show by this,
 * so a show saved under several names sorts as one.
 */
export function savedShows(mappings: CoverageMapping[], provider: CoverageProvider): Map<number, OrderedShow> {
  const shows = new Map<number, OrderedShow>();
  for (const mapping of [...mappings].sort(oldestFirst)) {
    for (const { provider: side, show, showId, showYear } of mapping.members) {
      if (side === provider) shows.set(showId, { show, showId, showYear });
    }
  }
  return shows;
}

/**
 * Manual Matches in the report's fixed order: by the TMDB show (see
 * `compareShows`, using each show ID's name from `savedShows`), then season,
 * then episode, as numbers, then Manual Match ID. A card spanning several TMDB
 * shows sorts by its first show's lowest episode; a card with no TMDB episode
 * sorts last.
 */
export function orderManualMatches<T extends CoverageMapping>(mappings: T[]): T[] {
  const shows = savedShows(mappings, "TMDB");
  const compareEpisodes = (a: CoverageMember, b: CoverageMember) => compareShows(shows.get(a.showId)!, shows.get(b.showId)!) || a.season - b.season || a.episode - b.episode;
  // The TMDB episode a card sorts by: the lowest episode of its first TMDB show.
  const anchor = (mapping: CoverageMapping) => mapping.members.filter(member => member.provider === "TMDB").sort(compareEpisodes)[0];
  const anchored = mappings.map(mapping => ({ mapping, anchor: anchor(mapping) }));
  return anchored.sort((a, b) => {
    if (!a.anchor || !b.anchor) return Number(!a.anchor) - Number(!b.anchor) || byId(a.mapping, b.mapping);
    return compareEpisodes(a.anchor, b.anchor) || byId(a.mapping, b.mapping);
  }).map(({ mapping }) => mapping);
}
