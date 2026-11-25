export type ProviderName = "Plex" | "TMDB" | "TVDB" | "Trakt";

export const PLEX_SCAN_WORKERS = 3;
/** Library inventory requests in flight at once, one per physical Plex record, each holding its slot across retries. They have no start spacing. */
export const LIBRARY_INVENTORY_REQUESTS = 8;
/** Shows whose catalogues are prepared at once while the Library inventory downloads. */
export const PLEX_PREPARATION_WORKERS = PLEX_SCAN_WORKERS;
/** Shows prepared early that may wait for their comparison before no further early preparation starts: the backpressure on preparation. */
export const PLEX_PREPARED_SHOWS_AHEAD = 64;
export const PROVIDER_REQUEST_SPACING_MS: Record<ProviderName, number> = { Plex: 25, TMDB: 50, TVDB: 200, Trakt: 250 };
