# Shelfcheck 2.4.0

Shelfcheck 2.4.0 adds persistent manual episode coverage for Plex scans.

## Manual episode coverage

Use **Link episodes** on a missing episode, or open **Manual Coverage**, to
resolve and review TMDB and TVDB episode URLs or provider-qualified IDs. Link
complete episode sets across seasons and shows, including combined specials
and their split parts. An incomplete source set grants no additional coverage.

Manual coverage runs after existing automatic matching and uses directly owned
Plex content across included libraries. Ambiguous combined/split metadata can
be corrected locally without changing Plex or provider records. Separate Trakt
collection scans retain their existing behavior.

Mappings and compatible ownership corrections survive restarts and cleared
reports or caches. Changes queue automatic rechecks with pending feedback and
protection against stale scan results. Incomplete results show owned content,
automatic satisfaction, remaining gaps, and alternative complete sets.

The manager supports editing, provider-health review, repair, individual
deletion, and confirmed bulk deletion of an explicit selection across pages.
Temporary provider failures retain pending state instead of deleting mappings.

## Upgrading

Use Docker image `andcbii/shelfcheck:2.4.0` or `andcbii/shelfcheck:latest` and
retain your existing `/config` and `/data` mounts. No configuration or database
reset is required. The first Plex scan refreshes older cached report data.

Reverse-proxy installations using Trakt OAuth must continue to set
`SHELFCHECK_PUBLIC_URL` to Shelfcheck's exact externally visible origin.
