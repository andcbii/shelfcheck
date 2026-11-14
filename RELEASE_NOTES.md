# Shelfcheck 2.5.4

Shelfcheck 2.5.4 refreshes needed TMDB episode crosswalks on a later UTC day,
so newly added or corrected TVDB external IDs can update Plex episode coverage
without a manual cache clear.

## Episode crosswalk freshness and recovery

- Needed TMDB external-ID episode crosswalks refresh independently of show
  change feeds. Usable matches and valid empty answers are reused on the same
  UTC day, with their original receipt times preserved across restarts.
- Show comparisons needing the same TVDB episode lookup share provider evidence
  and in-flight requests. Each comparison checks current library inventory.
- Failed or unreadable refreshes stop the older answer from granting coverage
  and remain retryable. Independent matching methods remain available.
- Offline Manual Match rechecks preserve rejected evidence and adopt later
  recovered answers durably across repeated rechecks and restarts.
- Explicit rescans, cache clearing and provider-change invalidation continue to
  override same-day reuse. Provider catalogue freshness rules are unchanged.

## Upgrading

Use `andcbii/shelfcheck:2.5.4` or `andcbii/shelfcheck:latest` and retain your
existing `/config` and `/data` mounts. Images support Linux amd64 and arm64.
No configuration or database reset is required.
