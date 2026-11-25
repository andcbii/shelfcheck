import type { CoverageMapping, CoverageMember } from "@/lib/manual-coverage-model";

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

const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const compareEpisodes = (a: CoverageMember, b: CoverageMember) => compareShows(a, b) || a.season - b.season || a.episode - b.episode;

// The TMDB episode a card sorts by: the lowest episode of its first TMDB show.
const anchor = (mapping: CoverageMapping) => mapping.members.filter(member => member.provider === "TMDB").sort(compareEpisodes)[0];

/**
 * Manual Matches in the report's fixed order: by the TMDB show (see
 * `compareShows`), then season, then episode, as numbers, then mapping ID.
 * A card spanning several TMDB shows sorts by its first show's lowest episode;
 * a card with no TMDB episode sorts last.
 */
export function orderManualMatches<T extends CoverageMapping>(mappings: T[]): T[] {
  const anchored = mappings.map(mapping => ({ mapping, anchor: anchor(mapping) }));
  return anchored.sort((a, b) => {
    if (!a.anchor || !b.anchor) return Number(!a.anchor) - Number(!b.anchor) || byId(a.mapping, b.mapping);
    return compareEpisodes(a.anchor, b.anchor) || byId(a.mapping, b.mapping);
  }).map(({ mapping }) => mapping);
}
