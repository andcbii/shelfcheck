import "server-only";
import { PROVIDER_NAME, PROVIDERS, selectComparisonCatalogue, type CatalogueProvider, type CatalogueSelection, type CatalogueUseState } from "@/lib/catalogue-selection";
export type { CatalogueUseState } from "@/lib/catalogue-selection";
import type { ShowProviderIds } from "@/lib/plex-inventory";
import { isPlexScanActive } from "@/lib/plex-scan-active";
import { database } from "@/lib/sqlite";

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
  /** When a fallback in use last failed to load, so its saved catalogue is compared. */
  usingFailedAt?: string;
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

type Db = ReturnType<typeof database>;
type CandidateRow = { identity: string; provider: CatalogueProvider; series_id: number; name: string | null };
type OverrideRow = { identity: string; provider: CatalogueProvider; series_id: number };
type SelectionRow = { identity: string; provider: CatalogueProvider; preferred_id: number | null; using_id: number | null; state: CatalogueUseState; selected_at: string;
  preferred_downloaded_at: string | null; preferred_usable_until: string | null; preferred_failed_at: string | null; using_downloaded_at: string | null; using_failed_at: string | null; derived_from: number | null };

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
 * overrides, and choose the catalogue each provider prefers. The catalogue in use is recorded only
 * once a comparison completes (`recordCatalogueUse`), so a scan that keeps last-good results never
 * describes a catalogue those results did not compare. Only a complete observation (every record
 * returned usable metadata) replaces the candidates or clears an override, and only it reports the
 * candidates Plex removed (`removed`). `saveRemovals`, called inside the same transaction when a
 * candidate was removed, saves what the removal drops, so a crash cannot commit one without the other.
 */
export function observeCatalogueCandidates(identity: string, observed: ShowProviderIds, complete: boolean, saveRemovals?: (selections: Record<CatalogueProvider, CatalogueSelection>) => void): Record<CatalogueProvider, CatalogueSelection> {
  const db = database();
  return transaction(db, () => {
    const selections = selectionsFor(db, identity, observed, complete);
    for (const provider of PROVIDERS) {
      const selection = selections[provider];
      if (selection.commit) {
        const previous = candidateIds(db, identity, provider);
        const keep = new Set(selection.candidates);
        for (const id of previous) if (!keep.has(id)) db.prepare("DELETE FROM shelfcheck_catalogue_candidates WHERE identity=? AND provider=? AND series_id=?").run(identity, provider, id);
        for (const id of selection.candidates) db.prepare("INSERT OR IGNORE INTO shelfcheck_catalogue_candidates(identity,provider,series_id) VALUES(?,?,?)").run(identity, provider, id);
      }
      if (selection.overrideCleared) db.prepare("DELETE FROM shelfcheck_catalogue_overrides WHERE identity=? AND provider=?").run(identity, provider);
    }
    if (PROVIDERS.some(provider => selections[provider].removed.length)) saveRemovals?.(selections);
    return selections;
  });
}

/**
 * What `observeCatalogueCandidates` would choose for this observation, saving nothing. While a Plex
 * scan runs, only that scan observes candidates and overrides cannot change, so its later observation
 * of the same show chooses the same.
 */
export function previewCatalogueCandidates(identity: string, observed: ShowProviderIds, complete: boolean): Record<CatalogueProvider, CatalogueSelection> {
  return selectionsFor(database(), identity, observed, complete);
}

function selectionsFor(db: Db, identity: string, observed: ShowProviderIds, complete: boolean): Record<CatalogueProvider, CatalogueSelection> {
  return Object.fromEntries(PROVIDERS.map(provider => {
    const previous = candidateIds(db, identity, provider);
    return [provider, selectComparisonCatalogue({
      ...(previous.length ? { previous } : {}),
      observed: observed[provider].filter(id => Number.isSafeInteger(id) && id > 0),
      complete,
      override: savedOverride(db, identity, provider),
    })];
  })) as Record<CatalogueProvider, CatalogueSelection>;
}

/**
 * Record the catalogue a scan is comparing for one provider. The preference itself (override and
 * candidates) is untouched, so a temporary fallback cannot erase it.
 */
export function recordCatalogueUse(identity: string, provider: CatalogueProvider, use: CatalogueUse) {
  const db = database();
  transaction(db, () => db.prepare(`INSERT INTO shelfcheck_catalogue_selections(identity,provider,preferred_id,using_id,state,selected_at,preferred_downloaded_at,preferred_usable_until,preferred_failed_at,using_downloaded_at,using_failed_at,derived_from) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(identity,provider) DO UPDATE SET preferred_id=excluded.preferred_id,using_id=excluded.using_id,state=excluded.state,selected_at=excluded.selected_at,preferred_downloaded_at=excluded.preferred_downloaded_at,
      preferred_usable_until=excluded.preferred_usable_until,preferred_failed_at=excluded.preferred_failed_at,using_downloaded_at=excluded.using_downloaded_at,using_failed_at=excluded.using_failed_at,derived_from=excluded.derived_from`)
    .run(identity, provider, use.preferredId ?? null, use.usingId ?? null, use.state, new Date().toISOString(), use.preferredDownloadedAt ?? null, use.preferredUsableUntil ?? null, use.preferredFailedAt ?? null, use.usingDownloadedAt ?? null, use.usingFailedAt ?? null, use.derivedFrom ?? null));
}

/** Forget the catalogue in use for a provider that has none this scan, such as a derived series no longer linked. */
export function clearCatalogueUse(identity: string, provider: CatalogueProvider) {
  database().prepare("DELETE FROM shelfcheck_catalogue_selections WHERE identity=? AND provider=?").run(identity, provider);
}

/** Save names for known candidates; names never affect the candidate set or an override. */
export function recordCatalogueCandidateNames(identity: string, provider: CatalogueProvider, names: { id: number; name?: string }[]) {
  const db = database();
  transaction(db, () => {
    for (const { id, name } of names) if (name) db.prepare("UPDATE shelfcheck_catalogue_candidates SET name=? WHERE identity=? AND provider=? AND series_id=?").run(name, identity, provider, id);
  });
}

/**
 * Save (or with `seriesId` null clear) a show's catalogue override for one provider, validating the
 * request: an active Plex scan rejects it first, then the ID must be one of the provider's currently
 * reported Plex candidates, of which there must be several.
 */
export function saveCatalogueOverride(identity: unknown, provider: unknown, seriesId: unknown) {
  const db = database();
  transaction(db, () => {
    if (isPlexScanActive()) throw new CatalogueSelectionError("Wait for the current Plex scan to finish before changing the comparison catalogue.", 409, "scan-active");
    if (typeof identity !== "string" || !identity) throw new CatalogueSelectionError("Supply the Plex show identity.");
    if (provider !== "tmdb" && provider !== "tvdb") throw new CatalogueSelectionError("Choose a TMDB or TVDB catalogue.");
    if (seriesId === null) {
      db.prepare("DELETE FROM shelfcheck_catalogue_overrides WHERE identity=? AND provider=?").run(identity, provider);
      return;
    }
    if (!(typeof seriesId === "number" && Number.isSafeInteger(seriesId) && seriesId > 0)) throw new CatalogueSelectionError("Choose a series ID, or clear the override.");
    const candidates = candidateIds(db, identity, provider);
    if (candidates.length < 2) throw new CatalogueSelectionError(`Plex reports only one ${PROVIDER_NAME[provider]} series for this show, so there is nothing to override.`);
    if (!candidates.includes(seriesId)) throw new CatalogueSelectionError(`Choose one of the ${PROVIDER_NAME[provider]} series IDs Plex currently reports for this show.`);
    db.prepare(`INSERT INTO shelfcheck_catalogue_overrides(identity,provider,series_id,saved_at) VALUES(?,?,?,?)
      ON CONFLICT(identity,provider) DO UPDATE SET series_id=excluded.series_id,saved_at=excluded.saved_at`).run(identity, provider, seriesId, new Date().toISOString());
  });
}

/** Saved candidates, overrides and current selections by show group identity. */
export function readCatalogueSelections(): Record<string, ShowCatalogueSelection> {
  return readSelections();
}
/** One show's saved candidates, override and current selections, if any are saved. */
export function readShowCatalogueSelection(identity: string): ShowCatalogueSelection | undefined {
  return readSelections(identity)[identity];
}
function readSelections(identity?: string): Record<string, ShowCatalogueSelection> {
  const db = database();
  const shows: Record<string, ShowCatalogueSelection> = {};
  const where = identity === undefined ? "" : " WHERE identity=?";
  const rows = <T,>(sql: string) => (identity === undefined ? db.prepare(sql).all() : db.prepare(sql).all(identity)) as T[];
  const entry = (key: string, provider: CatalogueProvider) => (shows[key] ||= { tmdb: { candidates: [] }, tvdb: { candidates: [] } })[provider];
  for (const row of rows<CandidateRow>(`SELECT identity,provider,series_id,name FROM shelfcheck_catalogue_candidates${where} ORDER BY identity,provider,series_id`))
    entry(row.identity, row.provider).candidates.push({ id: row.series_id, ...(row.name ? { name: row.name } : {}) });
  for (const row of rows<OverrideRow>(`SELECT identity,provider,series_id FROM shelfcheck_catalogue_overrides${where}`))
    entry(row.identity, row.provider).override = row.series_id;
  for (const row of rows<SelectionRow>(`SELECT * FROM shelfcheck_catalogue_selections${where}`)) {
    const optional = { preferredId: row.preferred_id, usingId: row.using_id, preferredDownloadedAt: row.preferred_downloaded_at, preferredUsableUntil: row.preferred_usable_until, preferredFailedAt: row.preferred_failed_at, usingDownloadedAt: row.using_downloaded_at, usingFailedAt: row.using_failed_at, derivedFrom: row.derived_from };
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
