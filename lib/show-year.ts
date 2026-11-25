import "server-only";
import type { CoverageMapping, CoverageProvider } from "@/lib/manual-coverage-model";
import { readPlexShowYears, savePlexShowYears, type PlexShowYear } from "@/lib/plex-catalogues";
import { usableShowYear } from "@/lib/plex-inventory";
import type { PlexShowResult } from "@/lib/plex-scan";

/**
 * Show year (GLOSSARY.md): the year shown with a provider show's name on Manual Matches. It is a
 * display value of a provider show (provider + show ID), never a field of a saved member and never a
 * coverage input, so changing it never moves a coverage revision or starts a recheck.
 *
 * Plex years come from a snapshot that only a completed full scan publishes, when it saves its
 * report: one row per Plex show group, with the provider shows the group holds and its last known
 * Plex year. Reads resolve years from that snapshot alone and make no network request.
 */

/** A provider show: its provider and show ID. */
export type ProviderShow = { provider: CoverageProvider; showId: number };

/**
 * What the latest completed full scan says about one provider show's Plex year: one known year;
 * a conflict between Plex groups with different years; held by Plex but with no known year; or
 * absent, held by no Plex group.
 */
export type PlexYear = { kind: "year"; year: number } | { kind: "conflict"; years: number[] } | { kind: "unknown" } | { kind: "absent" };

/** Resolves the Show year of a provider show, or undefined when it has none (shown by name only). */
export type ShowYears = (show: ProviderShow) => number | undefined;

/**
 * The provider shows a Plex show group holds: its selected TMDB and TVDB IDs and every provider
 * candidate it resolved. Never a name, a Manual Match link or an unresolved candidate.
 */
function heldProviderShows(show: PlexShowResult): { tmdb: number[]; tvdb: number[] } {
  const ids = (selected: number | undefined, candidates: { id: number; unresolved?: boolean }[] = []) =>
    [...new Set([...(selected ? [selected] : []), ...candidates.flatMap(candidate => candidate.unresolved ? [] : [candidate.id])])].sort((a, b) => a - b);
  return { tmdb: ids(show.tmdbId, show.providerMatches?.tmdb), tvdb: ids(show.tvdbId, show.providerMatches?.tvdb) };
}

/**
 * Publish the Plex years of a completed full scan's saved report. A group whose show the report
 * still holds without a usable year keeps its last known year; a group the report no longer holds
 * is dropped, so its provider shows become absent. Call it only where a completed full scan saves
 * its report, in the same transaction.
 */
export function publishPlexShowYears(shows: PlexShowResult[]): void {
  const previous = new Map(readPlexShowYears().map(row => [row.identity, row.year]));
  const published = new Map<string, PlexShowYear>();
  for (const show of shows) {
    if (published.has(show.ratingKey)) continue;
    const known = usableShowYear(show.year) ?? previous.get(show.ratingKey);
    published.set(show.ratingKey, { identity: show.ratingKey, ...(known === undefined ? {} : { year: known }), ...heldProviderShows(show) });
  }
  savePlexShowYears([...published.values()]);
}

/** The Plex year of one provider show in a published snapshot. */
function plexYear(snapshot: PlexShowYear[], { provider, showId }: ProviderShow): PlexYear {
  const groups = snapshot.filter(row => (provider === "TMDB" ? row.tmdb : row.tvdb).includes(showId));
  if (!groups.length) return { kind: "absent" };
  const years = [...new Set(groups.flatMap(row => row.year === undefined ? [] : [row.year]))].sort((a, b) => a - b);
  if (years.length === 1) return { kind: "year", year: years[0] };
  return years.length ? { kind: "conflict", years } : { kind: "unknown" };
}

/**
 * The Show year resolver over the published Plex years, read once. Only a single known Plex year
 * gives a year; a provider-year fallback for conflicting, unknown and absent shows plugs in here.
 */
export function readShowYears(): ShowYears {
  const snapshot = readPlexShowYears();
  return show => {
    const plex = plexYear(snapshot, show);
    return plex.kind === "year" ? plex.year : undefined;
  };
}

/** Manual Matches as the Manual Coverage read response serves them: each member with its Show year. */
export function withShowYears(mappings: CoverageMapping[]): CoverageMapping[] {
  const showYear = readShowYears();
  return mappings.map(mapping => ({ ...mapping, members: mapping.members.map(member => {
    const year = showYear(member);
    return year === undefined ? member : { ...member, showYear: year };
  }) }));
}
