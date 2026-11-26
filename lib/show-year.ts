import "server-only";
import type { CoverageMapping, CoverageProvider } from "@/lib/manual-coverage-model";
import { readPlexShowYears, readProviderShowYears, savePlexShowYears, saveProviderShowYears, type PlexShowYear } from "@/lib/plex-catalogues";
import { inDatabaseTransaction } from "@/lib/sqlite";
import { usableShowYear } from "@/lib/usable-show-year";
import type { PlexShowResult } from "@/lib/plex-scan";
import { providerLookup, type ProviderLookup } from "@/lib/provider-lookup";
import { runWorkerPool } from "@/lib/scan-concurrency";
import { plexGroupYear, showProviderIds, type PlexShowGroup } from "@/lib/plex-inventory";

/** How many year lookups of unvisited Manual Match shows a full scan has in flight at once. */
export const SHOW_YEAR_LOOKUP_WORKERS = 3;

/**
 * Show year (GLOSSARY.md): the year shown with a provider show's name on Manual Matches. It is a
 * display value of a provider show (provider + show ID), never a field of a saved member and never a
 * coverage input, so changing it never moves a coverage revision or starts a recheck.
 *
 * Plex years come from a snapshot that only a completed full scan publishes, when it saves its
 * report: one row per Plex show group, with the provider shows the group holds and its last known
 * Plex year. Provider years are saved per provider show from fresh successful provider answers
 * (a Manual Match save's show lookups, and a completed full scan's show details and its lookups of
 * Manual Match shows it did not otherwise visit). Reads resolve years from these two stores alone and make
 * no network request.
 */

/** A provider show: its provider and show ID. */
export type ProviderShow = { provider: CoverageProvider; showId: number };

/**
 * What the latest completed full scan says about one provider show's Plex year: one known year;
 * a conflict between Plex groups with different years; held by Plex but with no known year; or
 * absent, held by no Plex group.
 */
export type PlexYear = { kind: "year"; year: number } | { kind: "conflict" } | { kind: "unknown" } | { kind: "absent" };

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
 * The Plex years a completed full scan's library gives, one row per Plex show group, each with the
 * provider shows it holds: a compared show's verified provider shows (its selected IDs and resolved
 * candidates), or, for a library show it did not compare (an ignored show: an Ignore excludes
 * missing episodes, not the show), those its Plex GUIDs name. A group's year is its year in this
 * scan's library inventory, even when the scan kept the group's last-good comparison; a group the
 * library still holds without a usable year keeps its last known year; a group the library no
 * longer holds has no row, so its provider shows become absent. Reads the saved snapshot only.
 */
export function fullScanPlexShowYears(compared: PlexShowResult[], library: PlexShowGroup[]): PlexShowYear[] {
  const previous = new Map(readPlexShowYears().map(row => [row.identity, row.year]));
  const inventoryYears = new Map(library.map(group => [group.identity, plexGroupYear(group.records)]));
  const rows = new Map<string, PlexShowYear>();
  const add = (identity: string, year: number | undefined, held: { tmdb: number[]; tvdb: number[] }) => {
    if (rows.has(identity)) return;
    const known = usableShowYear(inventoryYears.has(identity) ? inventoryYears.get(identity) : year) ?? previous.get(identity);
    rows.set(identity, { identity, ...(known === undefined ? {} : { year: known }), ...held });
  };
  for (const show of compared) add(show.ratingKey, show.year, heldProviderShows(show));
  for (const group of library) {
    const ids = group.records.map(record => showProviderIds(record.Guid));
    add(group.identity, undefined, { tmdb: [...new Set(ids.flatMap(id => id.tmdb))].sort((a, b) => a - b), tvdb: [...new Set(ids.flatMap(id => id.tvdb))].sort((a, b) => a - b) });
  }
  return [...rows.values()];
}

/**
 * Give each show of a Plex report the published Plex year of its group, so the Plex page, the
 * report headers and Manual Matches read one value. Call it before any Plex report is saved: a
 * completed full scan passes the years it is about to publish; every other report write (a
 * targeted scan, a full scan that is not a completed one, a cached recheck, a cache clear) uses
 * the saved snapshot and publishes nothing. A show whose group the snapshot does not cover keeps
 * its own year.
 */
export function withPublishedPlexYears(shows: PlexShowResult[], published: PlexShowYear[] = readPlexShowYears()): void {
  const years = new Map(published.map(row => [row.identity, row.year]));
  for (const show of shows) {
    if (!years.has(show.ratingKey)) continue;
    const year = years.get(show.ratingKey);
    if (year === undefined) delete show.year;
    else show.year = year;
  }
}

/** Publish a completed full scan's Plex years (from `fullScanPlexShowYears`) once it has saved its report. */
export function publishPlexShowYears(published: PlexShowYear[]): void {
  savePlexShowYears(published);
}

/** The Plex year of one provider show in a published snapshot. */
function plexYear(snapshot: PlexShowYear[], { provider, showId }: ProviderShow): PlexYear {
  const groups = snapshot.filter(row => (provider === "TMDB" ? row.tmdb : row.tvdb).includes(showId));
  if (!groups.length) return { kind: "absent" };
  const years = [...new Set(groups.flatMap(row => row.year === undefined ? [] : [row.year]))].sort((a, b) => a - b);
  if (years.length === 1) return { kind: "year", year: years[0] };
  return years.length ? { kind: "conflict" } : { kind: "unknown" };
}

/**
 * A fresh successful provider answer about one provider show's own year: `year` is the raw value
 * the provider gave (a missing or malformed one is ignored), `observedAt` when the answer arrived.
 */
export type ProviderYearObservation = ProviderShow & { year: unknown; observedAt: number };

const providerShowKey = ({ provider, showId }: ProviderShow) => `${provider}:${showId}`;

/**
 * The raw year a provider's show details give: TMDB show details' `first_air_date` ("2005-03-26"),
 * or a TVDB series record's `year` ("2005"). Anything else gives none.
 */
export function showDetailsYear(provider: CoverageProvider, details: unknown): number | undefined {
  const value = details && typeof details === "object" ? (details as Record<string, unknown>)[provider === "TMDB" ? "first_air_date" : "year"] : undefined;
  const match = typeof value === "string" ? value.match(provider === "TMDB" ? /^(\d{4})-\d{2}-\d{2}$/ : /^(\d{4})$/) : null;
  return match ? usableShowYear(Number(match[1])) : undefined;
}

/** The provider show a show-details lookup asks about, if it is one. */
function showDetailsLookupShow(lookup: ProviderLookup): ProviderShow | undefined {
  switch (lookup.kind) {
    case "tmdb-series-summary":
    case "tmdb-series-summary-with-external-ids": return { provider: "TMDB", showId: lookup.tmdbShowId };
    case "tvdb-series-summary": return { provider: "TVDB", showId: lookup.tvdbSeriesId };
    default: return undefined;
  }
}

/**
 * A full scan's provider years for the provider shows its Manual Matches hold. The scan passes its
 * show-details requests through `watch` (typed lookups) or `request` (a show's details by other
 * means) as it sends them: each fresh successful answer is noted with the time it arrived. Saved
 * or reused answers never reach it, so they never write a year. Before saving its report, the scan
 * looks up once each Manual Match provider show it did not visit (`lookUpUnvisited`, a few at a
 * time, the one request ADR-0008 allows for this); a failed lookup only keeps the saved year.
 * `record` saves what was noted; call it only once a completed full scan has saved its report.
 */
export function fullScanProviderYears(mappings: CoverageMapping[]) {
  const wanted = new Map(mappings.flatMap(mapping => mapping.members.map(({ provider, showId }) => [providerShowKey({ provider, showId }), { provider, showId }] as const)));
  const requested = new Set<string>();
  const observed = new Map<string, ProviderYearObservation>();
  /** Send one show-details request for `show`; `details` reads the show details from its answer. */
  async function request<T>(show: ProviderShow, send: () => Promise<T>, details: (answer: T) => unknown = answer => answer): Promise<T> {
    const key = providerShowKey(show);
    requested.add(key);
    const answer = await send();
    if (wanted.has(key)) observed.set(key, { ...show, year: showDetailsYear(show.provider, details(answer)), observedAt: Date.now() });
    return answer;
  }
  /** A typed lookup transport whose show-details answers are noted. */
  function watch<T>(transport: (lookup: ProviderLookup) => Promise<T>) {
    return (lookup: ProviderLookup): Promise<T> => {
      const show = showDetailsLookupShow(lookup);
      // A TVDB series answer holds its record under `data`.
      return show ? request(show, () => transport(lookup), answer => show.provider === "TVDB" && answer && typeof answer === "object" ? (answer as { data?: unknown }).data : answer) : transport(lookup);
    };
  }
  return {
    request,
    watch,
    /**
     * Look up once each Manual Match provider show the scan did not visit: no Plex show in its
     * results holds it and it sent no show-details request for it. A failure goes to `failed` and
     * keeps the saved year.
     */
    async lookUpUnvisited(results: PlexShowResult[], transport: (lookup: ProviderLookup) => Promise<unknown>, failed: (show: ProviderShow, error: unknown) => void) {
      const visited = new Set(requested);
      for (const result of results) {
        const held = heldProviderShows(result);
        for (const showId of held.tmdb) visited.add(providerShowKey({ provider: "TMDB", showId }));
        for (const showId of held.tvdb) visited.add(providerShowKey({ provider: "TVDB", showId }));
      }
      const watched = watch(transport);
      const unvisited = [...wanted].flatMap(([key, show]) => visited.has(key) ? [] : [show]);
      // A few at a time, like removal-candidate confirmations, so a long list never floods a provider.
      await runWorkerPool(unvisited, SHOW_YEAR_LOOKUP_WORKERS, show => watched(show.provider === "TMDB" ? providerLookup.tmdbSeriesSummary(show.showId) : providerLookup.tvdbSeriesSummary(show.showId)).then(() => {}, (error: unknown) => failed(show, error)));
    },
    record: () => recordProviderYears([...observed.values()]),
  };
}

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
