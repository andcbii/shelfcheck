export const MAX_PLEX_POSTER_BYTES = 10 * 1024 * 1024;
const PLEX_THUMB_PATH = /^\/library\/metadata\/\d+\/thumb(?:\/\d+)?$/;

export function isAllowedPlexThumbPath(path: string) {
  return PLEX_THUMB_PATH.test(path);
}
