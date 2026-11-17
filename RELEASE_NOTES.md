# Shelfcheck 2.6.0

Shelfcheck 2.6.0 handles Plex shows that carry more than one TMDB or TVDB
series ID, and brings its framework and build dependencies up to date.

## Shows with multiple provider IDs

- Plex can attach several TMDB or TVDB series IDs to one show. Shelfcheck now
  keeps all of them and compares against the lowest ID by default, so the
  result no longer depends on the order Plex lists them.
- The new Multiple Provider IDs report lists these shows and lets you choose
  which series each provider uses. Your choice is kept when the cache is
  cleared, and the show is rechecked right away from saved data.
- Results for these shows include a note with a Review IDs link to the report.
- If the chosen series cannot be loaded, its saved catalogue stays in use for
  up to 60 days, then Shelfcheck falls back to the lowest usable ID until the
  chosen series loads again. These shows refresh their catalogues every 20
  days.
- The first scan after upgrading may switch some shows to their lowest ID.
  This is expected; choose a different ID in the report if needed.

## Dependency and build updates

- Next.js 16.4.6, which fixes advisories GHSA-mfr8-8qww-v76h and
  GHSA-vc7v-qv4w-wrv8, React 19.3.1, Tailwind CSS 4.3.5 and TypeScript 6.0.3,
  plus build and lint tooling updates.
- GitHub Actions are pinned by commit SHA and the Node 24 base image by digest,
  with weekly Dependabot update pull requests.

## Upgrading

Use `andcbii/shelfcheck:2.6.0` or `andcbii/shelfcheck:latest` and retain your
existing `/config` and `/data` mounts. Images support Linux amd64 and arm64.
No configuration or database reset is required.
