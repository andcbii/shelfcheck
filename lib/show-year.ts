import "server-only";
import type { CoverageMapping, CoverageProvider } from "@/lib/manual-coverage-model";
import { readPlexShowYears, readProviderShowYears, savePlexShowYears, saveProviderShowYears, type PlexShowYear } from "@/lib/plex-catalogues";
import { inDatabaseTransaction } from "@/lib/sqlite";
import { usableShowYear } from "@/lib/plex-inventory";
import type { PlexShowResult } from "@/lib/plex-scan";

/**
 * Show year (GLOSSARY.md): the year shown with a provider show's name on Manual Matches. It is a
 * display value of a provider show (provider + show ID), never a field of a saved member and never a
 * coverage input, so changing it never moves a coverage revision or starts a recheck.
 *
 * Plex years come from a snapshot that only a completed full scan publishes, when it saves its
 * report: one row per Plex show group, with the provider shows the group holds and its last known
 * Plex year. Provider years are saved per provider show from fresh successful provider answers
 * (a Manual Match save's show lookups). Reads resolve years from these two stores alone and make
 * no network request.
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
 * A fresh successful provider answer about one provider show's own year: `year` is the raw value
 * the provider gave (a missing or malformed one is ignored), `observedAt` when the answer arrived.
 */
export type ProviderYearObservation = ProviderShow & { year: unknown; observedAt: number };

const providerShowKey = ({ provider, showId }: ProviderShow) => `${provider}:${showId}`;

/**
 * Save provider years from fresh successful provider answers. Only a usable year (an integer from
 * 1000 to 9999) is written, and only when it is at least as new as the saved one: a missing or
 * malformed year, or an older answer, keeps the saved value. Never clears a year, never touches
 * coverage. Joins an open database transaction, so a full scan can stage observations during its
 * run and record them where it commits its report.
 */
export function recordProviderYears(observations: ProviderYearObservation[]): void {
  const fresh = observations.flatMap(observation => {
    const year = usableShowYear(observation.year);
    return year === undefined ? [] : [{ provider: observation.provider, showId: observation.showId, year, observedAt: observation.observedAt }];
  });
  if (!fresh.length) return;
  inDatabaseTransaction(() => {
    const saved = new Map(readProviderShowYears().map(row => [providerShowKey(row), row]));
    let changed = false;
    for (const observation of fresh) {
      const previous = saved.get(providerShowKey(observation));
      if (previous && previous.observedAt > observation.observedAt) continue;
      if (previous?.year === observation.year && previous.observedAt === observation.observedAt) continue;
      saved.set(providerShowKey(observation), observation);
      changed = true;
    }
    if (changed) saveProviderShowYears([...saved.values()]);
  });
}

/**
 * The Show year resolver, read once with no network request. A single known Plex year wins; a
 * provider show that Plex groups with different years hold, that Plex holds with no known year,
 * or that no Plex group holds, takes its saved provider year; with neither it has no year.
 */
export function readShowYears(): ShowYears {
  const snapshot = readPlexShowYears();
  const providerYears = new Map(readProviderShowYears().map(row => [providerShowKey(row), row.year]));
  return show => {
    const plex = plexYear(snapshot, show);
    return plex.kind === "year" ? plex.year : providerYears.get(providerShowKey(show));
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
