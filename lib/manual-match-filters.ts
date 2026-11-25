import type { CoverageMapping, CoverageProvider } from "@/lib/manual-coverage-model";
import { compareShows, savedShows, type OrderedShow } from "@/lib/manual-match-order";

/** A show filter option: one provider show used in saved Manual Matches. */
export type ShowOption = OrderedShow & { label: string };
/** The shows picked in each show filter, by provider show ID. */
export type ShowPicks = Record<CoverageProvider, number[]>;
export const noShowPicks: ShowPicks = { TMDB: [], TVDB: [] };

/**
 * One option per show ID on `provider`'s side of the saved Manual Matches,
 * named as in the most recently created match holding it (see `savedShows`),
 * labelled "Show Name (Year)" when its Show year is known, and in the report's
 * show order.
 */
export function showOptions(mappings: CoverageMapping[], provider: CoverageProvider): ShowOption[] {
  return [...savedShows(mappings, provider).values()].sort(compareShows).map(show => ({ ...show, label: show.showYear ? `${show.show} (${show.showYear})` : show.show }));
}

/**
 * The picks whose show is still on that side of a saved Manual Match, or
 * `picks` itself when every picked show still is.
 */
export function savedShowPicks(mappings: CoverageMapping[], picks: ShowPicks): ShowPicks {
  const saved = (provider: CoverageProvider, showId: number) => mappings.some(mapping => mapping.members.some(member => member.provider === provider && member.showId === showId));
  const kept: ShowPicks = { TMDB: picks.TMDB.filter(showId => saved("TMDB", showId)), TVDB: picks.TVDB.filter(showId => saved("TVDB", showId)) };
  return kept.TMDB.length === picks.TMDB.length && kept.TVDB.length === picks.TVDB.length ? picks : kept;
}

export const filteringShows =(picks: ShowPicks) => picks.TMDB.length > 0 || picks.TVDB.length > 0;

/**
 * The Manual Matches the show filters keep. A match belongs to a show when any
 * member on that side has its show ID; picks combine with OR within a side and
 * AND across the sides.
 */
export function filterByShows<T extends CoverageMapping>(mappings: T[], picks: ShowPicks): T[] {
  const sides = (Object.keys(picks) as CoverageProvider[]).filter(provider => picks[provider].length);
  return mappings.filter(mapping => sides.every(provider => mapping.members.some(member => member.provider === provider && picks[provider].includes(member.showId))));
}
