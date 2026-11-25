export const MAX_PLEX_POSTER_BYTES = 10 * 1024 * 1024;
const PLEX_THUMB_PATH = /^\/library\/metadata\/\d+\/thumb(?:\/\d+)?$/;

/** The app's Plex poster proxy link for a thumbnail path. */
export function plexPosterSrc(thumb: string) {
  return `/api/plex/poster?thumb=${encodeURIComponent(thumb)}`;
}

export function isAllowedPlexThumbPath(path: string) {
  return PLEX_THUMB_PATH.test(path);
}
