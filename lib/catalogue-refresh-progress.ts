import type { CatalogueRefreshState } from "@/lib/coverage-issues";
import { GONE_RECORD_NOT_FOUND_DAYS } from "@/lib/plex-catalogue-policy";

const DAY = 86400_000;
const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

/**
 * A catalogue-refresh Scan Issue's catalogue age and 404 progress, as of the resolution that
 * recorded it: "404 on 7 of 15 days · catalogue 74 days old", "404 on 3 days · never downloaded",
 * "Gone: 404 on 16 days · catalogue 74 days old" for a Gone provider record,
 * or the age alone when the failure was not a series-request 404.
 */
export function catalogueRefreshProgress(state: CatalogueRefreshState): string {
  const age = state.downloadedAt === undefined ? undefined : Math.max(0, Math.floor((Date.parse(state.checkedAt) - Date.parse(state.downloadedAt)) / DAY));
  if (state.gone && state.seriesNotFoundDays !== undefined && age !== undefined) return `Gone: 404 on ${days(state.seriesNotFoundDays)} · catalogue ${days(age)} old`;
  if (state.seriesNotFoundDays === undefined) return age === undefined ? "Never downloaded" : `Catalogue ${days(age)} old`;
  if (age === undefined) return `404 on ${days(state.seriesNotFoundDays)} · never downloaded`;
  return `404 on ${state.seriesNotFoundDays} of ${GONE_RECORD_NOT_FOUND_DAYS} days · catalogue ${days(age)} old`;
}
