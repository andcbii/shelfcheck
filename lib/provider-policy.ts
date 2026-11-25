export type ProviderName = "Plex" | "TMDB" | "TVDB" | "Trakt";

export const PLEX_SCAN_WORKERS = 3;
/** Plex episode inventory requests in flight at once, one per physical record, each holding its slot across retries. They have no start spacing. */
export const PLEX_INVENTORY_REQUESTS = 8;
/** Shows whose catalogues are prepared at once while the Plex inventory downloads, and how many prepared shows may wait for their comparison. */
export const PLEX_PREPARATION_WORKERS = PLEX_SCAN_WORKERS;
export const PLEX_PREPARED_SHOWS_AHEAD = 64;
export const PROVIDER_REQUEST_SPACING_MS: Record<ProviderName, number> = { Plex: 25, TMDB: 50, TVDB: 200, Trakt: 250 };
