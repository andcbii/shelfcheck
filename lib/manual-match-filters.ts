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

const providers = (picks: ShowPicks) => Object.keys(picks) as CoverageProvider[];

/**
 * `picks` pruned to the shows still on that side of a saved Manual Match, or
 * `picks` itself when none needs pruning.
 */
export function pruneShowPicks(mappings: CoverageMapping[], picks: ShowPicks): ShowPicks {
  const saved = (provider: CoverageProvider, showId: number) => mappings.some(mapping => mapping.members.some(member => member.provider === provider && member.showId === showId));
  const kept = Object.fromEntries(providers(picks).map(provider => [provider, picks[provider].filter(showId => saved(provider, showId))])) as ShowPicks;
  return providers(picks).every(provider => kept[provider].length === picks[provider].length) ? picks : kept;
}

/** Whether any show is picked in either show filter. */
export const filteringShows = (picks: ShowPicks) => providers(picks).some(provider => picks[provider].length > 0);

/**
 * The Manual Matches the show filters keep. A match belongs to a show when any
 * member on that side has its show ID; picks combine with OR within a side and
 * AND across the sides. With nothing picked it keeps every match.
 */
export function filterByShows<T extends CoverageMapping>(mappings: T[], picks: ShowPicks): T[] {
  const sides = providers(picks).filter(provider => picks[provider].length);
  return mappings.filter(mapping => sides.every(provider => mapping.members.some(member => member.provider === provider && picks[provider].includes(member.showId))));
}
