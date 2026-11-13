# Shelfcheck 2.5.3

Shelfcheck 2.5.3 keeps episode matching problems from stopping comparison of an
entire Plex show and recovers missing TVDB titles from English translations.

## Episode matching and recovery

- Individual malformed catalogue records and failed episode lookups are isolated
  to the affected episode and dependent relationships. Other episodes and
  independent matching methods continue normally.
- TVDB's default catalogue remains the first source. When an episode's title is
  unusable, Shelfcheck requests that episode's English translation, preserving
  provider identities and numbering. Recovered titles are saved for reuse.
- Unresolved episode lookups retry on subsequent user-requested scans, even when
  the rest of the catalogue is reused. Recovery state survives restarts.
- Failed checks appear in **05 — Scan Issues**, including when another method
  establishes coverage. Episodes without established coverage remain in normal
  Plex missing results under the existing visibility rules.
- Cached Manual Match rechecks stay offline and isolate unavailable episode
  relationships. Unusable shared catalogues retain existing last-good safeguards.

## Upgrading

Use `andcbii/shelfcheck:2.5.3` or `andcbii/shelfcheck:latest` and retain your
existing `/config` and `/data` mounts. Images support Linux amd64 and arm64.
No configuration or database reset is required.
