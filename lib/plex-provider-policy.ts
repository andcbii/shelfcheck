export type PlexProviderName = "Plex" | "TMDB" | "TVDB" | "Trakt";

export const PLEX_SCAN_WORKERS = 3;
export const PROVIDER_REQUEST_SPACING_MS: Record<PlexProviderName, number> = { Plex: 25, TMDB: 50, TVDB: 200, Trakt: 250 };
