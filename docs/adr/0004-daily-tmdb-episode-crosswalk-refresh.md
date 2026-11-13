---
status: accepted
---

# Refresh needed TMDB episode crosswalks on a new UTC day

TMDB can add or correct a TVDB episode's external ID without reporting the show in its change feed. Saved TMDB external-ID crosswalk responses were reused until a forced refresh or a provider-change invalidation, so a valid empty answer could keep an owned episode in missing results indefinitely.

Each saved provider relationship records the time its response was actually received. When a live scan reaches the TMDB external-ID crosswalk for a TVDB episode (lookup by TVDB episode ID), it reuses a saved response only if that response was received on or after the scan's starting UTC date; otherwise, including responses saved before receipt times were recorded, it requests the crosswalk again. Matches and valid empty responses are treated alike. A response received after midnight during a scan is current for that scan and for later scans on its receipt date.

The check is lazy and per episode: only crosswalks that normal matching actually reaches are refreshed, so earlier coverage avoids the request and an unused old response creates neither a request nor a Coverage Issue. There is no midnight job and no bulk refresh of undated responses. Reuse, offline cached rechecks and restarts never renew a receipt time, and receipt dates are never inferred from catalogue downloads.

When a required refresh fails, the expired response is not retained as usable evidence, so it grants no coverage; existing episode-scoped failure handling, retries and Coverage Issues apply. A fresh valid empty response replaces the old answer and withdraws only the coverage it established.

This augments ADR-0003 rather than reopening it: provider catalogue download timestamps, age limits, same-day catalogue reuse, change-feed verification and the fifth-scan safeguard are unchanged, as are IMDb and Trakt crosswalk reuse, explicit cache clearing, single-show rescans and provider-change invalidation, which still bypass same-day reuse. ADR-0001 Manual Match coverage is unchanged.
