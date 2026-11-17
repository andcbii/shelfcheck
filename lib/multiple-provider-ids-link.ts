/** The Multiple Provider IDs report entry for a show group identity (`plex://show/...` or `ratingKey:N`). */
export function multipleProviderIdsHref(identity: string): string {
  return `/reports/multiple-provider-ids#show-${encodeURIComponent(identity)}`;
}
