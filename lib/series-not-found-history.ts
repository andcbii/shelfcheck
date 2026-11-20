import "server-only";
import type { CatalogueProvider } from "@/lib/catalogue-selection";
import { database } from "@/lib/sqlite";

/**
 * The 404 history of provider series requests (ADR-0006): per provider and series ID, the UTC days
 * its series request (TMDB `/tv/{id}`, TVDB `/series/{id}`) answered 404 since its last complete
 * catalogue download. Shared by every show reporting the ID, durable across restarts and Clear cache.
 * Only the live download source changes it; cached rechecks only read it.
 */
export type SeriesNotFoundHistory = {
  /** Counted 404 days since the last complete download; 0 for an ID with no history. */
  countedDays(provider: CatalogueProvider, id: number): number;
  /** Count a series-request 404 received at `at` (ISO), at most once per UTC day; returns the count after it. */
  recordNotFound(provider: CatalogueProvider, id: number, at: string): number;
  /** A complete catalogue download resets the count to 0. */
  resetAfterCompleteDownload(provider: CatalogueProvider, id: number): void;
};

type Row = { counted_days: number; last_counted_day: string };

/** The history as stored in the Shelfcheck database. */
export function seriesNotFoundHistory(): SeriesNotFoundHistory {
  const row = (provider: CatalogueProvider, id: number) =>
    database().prepare("SELECT counted_days, last_counted_day FROM shelfcheck_series_not_found WHERE provider=? AND series_id=?").get(provider, id) as Row | undefined;
  return {
    countedDays: (provider, id) => row(provider, id)?.counted_days ?? 0,
    recordNotFound(provider, id, at) {
      const day = new Date(at).toISOString().slice(0, 10);
      const saved = row(provider, id);
      if (saved?.last_counted_day === day) return saved.counted_days;
      const counted = (saved?.counted_days ?? 0) + 1;
      database().prepare(`INSERT INTO shelfcheck_series_not_found(provider, series_id, counted_days, last_counted_day) VALUES(?,?,?,?)
        ON CONFLICT(provider, series_id) DO UPDATE SET counted_days=excluded.counted_days, last_counted_day=excluded.last_counted_day`).run(provider, id, counted, day);
      return counted;
    },
    resetAfterCompleteDownload(provider, id) {
      database().prepare("DELETE FROM shelfcheck_series_not_found WHERE provider=? AND series_id=?").run(provider, id);
    },
  };
}
