---
status: accepted
---

# Let the user's own decisions take precedence over automatic matching

Report Missing and a Manual Match are both set by the user, so both are checked before any automatic method. Each episode's coverage is decided in this order: Report Missing, then a Healthy Manual Match that covers the episode, then season and episode numbers, then automatic evidence (direct identities, episode crosswalks and compound matching), then missing results. This supersedes ADR-0001's order, which checked the Manual Match last as a fallback. That order ran every automatic per-episode lookup, one or more provider requests each, before reaching a match the user had already saved (SHELFCHECK-159).

A Manual Match takes precedence only when it grants coverage: the match is Healthy and every member on the other side is directly owned. Otherwise the episode falls through to the numbers check and automatic evidence as before. Pending and Needs review matches add no coverage and change nothing.

## Consequences

- A TVDB episode a Manual Match covers gets no IMDb, Trakt or TMDB episode crosswalk lookup and takes no part in compound matching.
- An episode a Manual Match covers is shown as covered by its Manual Match even when its numbers or a direct identity also match. It appears in the Manual Matches report and no longer produces an Auto Match record. In the Manual Matches report, a member owned directly still shows **Directly owned**.
- A crosswalk or compound check a Manual Match made unnecessary is not a failure, as for Report Missing: its recorded cause is dropped from Scan Issues.
- Saved results keep the old order until each show is compared again by a scan or a cached recheck. There is no migration.

## Considered options

- **Keep ADR-0001's order and only share requests.** Sharing one TVDB episode request between the Manual Match health recheck and the IMDb crosswalk removes a duplicate, but the crosswalk lookups for covered episodes stay. Rejected; with this order, the overlap is limited to Healthy matches whose other side is not owned.
- **Manual Match after the numbers check.** This skips the same lookups, but lets a numbers match decide an episode the user mapped by hand. Rejected: the user's decision comes first.
- **Answer the health recheck from saved catalogues.** A saved catalogue only proves an episode existed when it was downloaded, so a provider outage would keep a match Healthy instead of Pending. Out of scope; the health recheck still asks each provider every scan.
