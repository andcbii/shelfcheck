import "server-only";
import { selectComparisonCatalogue, type CatalogueProvider, type CatalogueSelection, type CatalogueUseState } from "@/lib/catalogue-selection";
export type { CatalogueUseState } from "@/lib/catalogue-selection";
import type { ShowProviderIds } from "@/lib/plex-inventory";
import { catalogueSelectionDatabase } from "@/lib/sqlite";

const PROVIDERS: CatalogueProvider[] = ["tmdb", "tvdb"];

export class CatalogueSelectionError extends Error {
  constructor(message: string, public status = 400, public code = "validation") {
    super(message);
  }
}

/**
 * The catalogue a scan chose to compare for one provider, recorded separately from the preference
 * so reports can show it without recalculating. Times are ISO strings.
 */
export type CurrentCatalogue = {
  preferredId?: number;
  /** The series whose catalogue is compared; absent when no catalogue is usable. */
  usingId?: number;
  state: CatalogueUseState;
  selectedAt: string;
  /** Last successful download of the preferred series' catalogue. */
  preferredDownloadedAt?: string;
  /** For a provider with several candidates: the last moment the saved preferred catalogue may still be compared (60 days after its download). */
  preferredUsableUntil?: string;
  /** When the preferred series last failed to load, while it is unavailable. */
  preferredFailedAt?: string;
  /** Last successful download of the catalogue in use. */
  usingDownloadedAt?: string;
  /** For a `derived` series: the other provider's series whose catalogue supplied it. */
  derivedFrom?: number;
};
/** What a scan records about the catalogue it is using. */
export type CatalogueUse = Omit<CurrentCatalogue, "selectedAt">;

export type ProviderCatalogueSelection = {
  /** The last completely observed Plex candidates, with names when known. */
  candidates: { id: number; name?: string }[];
  automaticId?: number;
  override?: number;
  /** The override when saved, else the automatic choice. */
  preferredId?: number;
  current?: CurrentCatalogue;
};

export type ShowCatalogueSelection = Record<CatalogueProvider, ProviderCatalogueSelection>;

type Db = ReturnType<typeof catalogueSelectionDatabase>;
type CandidateRow = { identity: string; provider: CatalogueProvider; series_id: number; name: string | null };
type OverrideRow = { identity: string; provider: CatalogueProvider; series_id: number };
type SelectionRow = { identity: string; provider: CatalogueProvider; preferred_id: number | null; using_id: number | null; state: CatalogueUseState; selected_at: string;
  preferred_downloaded_at: string | null; preferred_usable_until: string | null; preferred_failed_at: string | null; using_downloaded_at: string | null; derived_from: number | null };

function transaction<T>(db: Db, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const candidateIds = (db: Db, identity: string, provider: CatalogueProvider) =>
  (db.prepare("SELECT series_id FROM shelfcheck_catalogue_candidates WHERE identity=? AND provider=? ORDER BY series_id").all(identity, provider) as { series_id: number }[]).map(row => row.series_id);
const savedOverride = (db: Db, identity: string, provider: CatalogueProvider) =>
  (db.prepare("SELECT series_id FROM shelfcheck_catalogue_overrides WHERE identity=? AND provider=?").get(identity, provider) as { series_id: number } | undefined)?.series_id;

/**
 * Reconcile this scan's Plex observation of a show group with its saved candidates and
 * overrides, and record the catalogue each provider will compare. Only a complete observation
 * (every record returned usable metadata) replaces the candidates or clears an override.
 */
export function observeCatalogueCandidates(identity: string, observed: ShowProviderIds, complete: boolean): Record<CatalogueProvider, CatalogueSelection> {
  const db = catalogueSelectionDatabase();
  const selectedAt = new Date().toISOString();
  return transaction(db, () => Object.fromEntries(PROVIDERS.map(provider => {
    const previous = candidateIds(db, identity, provider);
    const selection = selectComparisonCatalogue({
      ...(previous.length ? { previous } : {}),
      observed: observed[provider].filter(id => Number.isSafeInteger(id) && id > 0),
      complete,
      override: savedOverride(db, identity, provider),
    });
    if (selection.commit) {
      const keep = new Set(selection.candidates);
      for (const id of previous) if (!keep.has(id)) db.prepare("DELETE FROM shelfcheck_catalogue_candidates WHERE identity=? AND provider=? AND series_id=?").run(identity, provider, id);
      for (const id of selection.candidates) db.prepare("INSERT OR IGNORE INTO shelfcheck_catalogue_candidates(identity,provider,series_id) VALUES(?,?,?)").run(identity, provider, id);
    }
    if (selection.overrideCleared) db.prepare("DELETE FROM shelfcheck_catalogue_overrides WHERE identity=? AND provider=?").run(identity, provider);
    if (selection.preferredId === undefined) db.prepare("DELETE FROM shelfcheck_catalogue_selections WHERE identity=? AND provider=?").run(identity, provider);
    else db.prepare(`INSERT INTO shelfcheck_catalogue_selections(identity,provider,preferred_id,using_id,state,selected_at) VALUES(?,?,?,?,'preferred',?)
      ON CONFLICT(identity,provider) DO UPDATE SET preferred_id=excluded.preferred_id,using_id=excluded.using_id,state=excluded.state,selected_at=excluded.selected_at`)
      .run(identity, provider, selection.preferredId, selection.preferredId, selectedAt);
    return [provider, selection];
  })) as Record<CatalogueProvider, CatalogueSelection>);
}

/**
 * Record the catalogue a scan is comparing for one provider. The preference itself (override and
 * candidates) is untouched, so a temporary fallback cannot erase it.
 */
export function recordCatalogueUse(identity: string, provider: CatalogueProvider, use: CatalogueUse) {
  const db = catalogueSelectionDatabase();
  transaction(db, () => db.prepare(`INSERT INTO shelfcheck_catalogue_selections(identity,provider,preferred_id,using_id,state,selected_at,preferred_downloaded_at,preferred_usable_until,preferred_failed_at,using_downloaded_at,derived_from) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(identity,provider) DO UPDATE SET preferred_id=excluded.preferred_id,using_id=excluded.using_id,state=excluded.state,selected_at=excluded.selected_at,preferred_downloaded_at=excluded.preferred_downloaded_at,
      preferred_usable_until=excluded.preferred_usable_until,preferred_failed_at=excluded.preferred_failed_at,using_downloaded_at=excluded.using_downloaded_at,derived_from=excluded.derived_from`)
    .run(identity, provider, use.preferredId ?? null, use.usingId ?? null, use.state, new Date().toISOString(), use.preferredDownloadedAt ?? null, use.preferredUsableUntil ?? null, use.preferredFailedAt ?? null, use.usingDownloadedAt ?? null, use.derivedFrom ?? null));
}

/** Forget the catalogue in use for a provider that has none this scan, such as a derived series no longer linked. */
export function clearCatalogueUse(identity: string, provider: CatalogueProvider) {
  catalogueSelectionDatabase().prepare("DELETE FROM shelfcheck_catalogue_selections WHERE identity=? AND provider=?").run(identity, provider);
}

/** Save names for known candidates; names never affect the candidate set or an override. */
export function recordCatalogueCandidateNames(identity: string, provider: CatalogueProvider, names: { id: number; name?: string }[]) {
  const db = catalogueSelectionDatabase();
  transaction(db, () => {
    for (const { id, name } of names) if (name) db.prepare("UPDATE shelfcheck_catalogue_candidates SET name=? WHERE identity=? AND provider=? AND series_id=?").run(name, identity, provider, id);
  });
}

/**
 * Save (or with `seriesId` null clear) a show's catalogue override for one provider. The ID
 * must be one of the provider's currently reported Plex candidates. Rejected while a Plex scan runs.
 */
export function saveCatalogueOverride(identity: string, provider: CatalogueProvider, seriesId: number | null) {
  if (!PROVIDERS.includes(provider)) throw new CatalogueSelectionError("Choose a TMDB or TVDB catalogue.");
  const db = catalogueSelectionDatabase();
  transaction(db, () => {
    if ((globalThis as typeof globalThis & { __shelfcheckPlexScan?: Promise<void> }).__shelfcheckPlexScan)
      throw new CatalogueSelectionError("Wait for the current Plex scan to finish before changing the comparison catalogue.", 409, "scan-active");
    if (seriesId === null) {
      db.prepare("DELETE FROM shelfcheck_catalogue_overrides WHERE identity=? AND provider=?").run(identity, provider);
      return;
    }
    if (!candidateIds(db, identity, provider).includes(seriesId))
      throw new CatalogueSelectionError(`Choose one of the ${provider.toUpperCase()} series IDs Plex currently reports for this show.`);
    db.prepare(`INSERT INTO shelfcheck_catalogue_overrides(identity,provider,series_id,saved_at) VALUES(?,?,?,?)
      ON CONFLICT(identity,provider) DO UPDATE SET series_id=excluded.series_id,saved_at=excluded.saved_at`).run(identity, provider, seriesId, new Date().toISOString());
  });
}

/** Saved candidates, overrides and current selections by show group identity. */
export function readCatalogueSelections(): Record<string, ShowCatalogueSelection> {
  const db = catalogueSelectionDatabase();
  const shows: Record<string, ShowCatalogueSelection> = {};
  const entry = (identity: string, provider: CatalogueProvider) => (shows[identity] ||= { tmdb: { candidates: [] }, tvdb: { candidates: [] } })[provider];
  for (const row of db.prepare("SELECT identity,provider,series_id,name FROM shelfcheck_catalogue_candidates ORDER BY identity,provider,series_id").all() as CandidateRow[])
    entry(row.identity, row.provider).candidates.push({ id: row.series_id, ...(row.name ? { name: row.name } : {}) });
  for (const row of db.prepare("SELECT identity,provider,series_id FROM shelfcheck_catalogue_overrides").all() as OverrideRow[])
    entry(row.identity, row.provider).override = row.series_id;
  for (const row of db.prepare("SELECT * FROM shelfcheck_catalogue_selections").all() as SelectionRow[]) {
    const optional = { preferredId: row.preferred_id, usingId: row.using_id, preferredDownloadedAt: row.preferred_downloaded_at, preferredUsableUntil: row.preferred_usable_until, preferredFailedAt: row.preferred_failed_at, usingDownloadedAt: row.using_downloaded_at, derivedFrom: row.derived_from };
    entry(row.identity, row.provider).current = { ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== null)), state: row.state, selectedAt: row.selected_at };
  }
  for (const show of Object.values(shows)) for (const provider of PROVIDERS) {
    const selection = show[provider];
    selection.automaticId = selection.candidates[0]?.id;
    if (selection.automaticId === undefined) delete selection.automaticId;
    const preferredId = selection.override ?? selection.automaticId;
    if (preferredId !== undefined) selection.preferredId = preferredId;
  }
  return shows;
}
