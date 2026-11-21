---
status: accepted
amends: ADR-0003, ADR-0005
---

# Stop comparing a provider record only after repeated not-found answers

ADR-0003 keeps the last-good catalogue whenever a refresh fails, at any age, and ADR-0005 left shows with one ID per provider on that rule. A record the provider has really deleted therefore kept producing missing-episode results indefinitely. A single 404 cannot be trusted as deletion, because neither TMDB nor TVDB reliably signals it and a 404 can be temporary. So a series ID becomes a Gone provider record only when two independent conditions both hold: its series request (TMDB `/tv/{id}`, TVDB `/series/{id}`) has answered 404 on 15 separate UTC days since its last complete catalogue download, and its saved catalogue is more than 60 days old. Days count once each however many scans run, and 404s before day 60 count. Only a complete catalogue download resets the count. Other failures (outages, 5xx, rate limits, cooldowns, sign-in failures, unreadable answers), 404s on seasons, episodes or other requests, and partial downloads neither count nor reset it. The count is kept per provider and series ID, shared by every show reporting that ID, and survives restarts, Plex dropping the ID, and clearing a show's cache. An ID never downloaded has no catalogue age and is never gone; it simply has no catalogue. Both limits are fixed, not settings.

A gone record's catalogue is kept but never compared, including in cached rechecks, and is used again after one complete download. Manual Matches on it are kept. ADR-0005's selection is unchanged: while any candidate works or has a saved catalogue 60 days old or less, it chooses as before. Only when no candidate qualifies does Shelfcheck keep the most recently saved catalogue that is not gone, at any age, as ADR-0003 does for single-ID providers. With several candidates, the provider is gone for the show only when every candidate is gone.

Each provider is judged separately from the catalogue in use, not from which IDs Plex reports: an ID works when its latest download attempt succeeded or its catalogue was reused without one, including IDs Shelfcheck found through the other provider, and untried candidates don't count as failing. A show is compared with whatever catalogues remain usable, so one provider's failure never blocks the other's comparison, and a scan never republishes an earlier result's provider status. A show with a Total Provider Lookup Failure at one provider is a Partially matched show; it becomes an Unmatched show only when no provider has a usable catalogue, live or saved. Hiding an Unmatched show's own entries from Scan Issues is a report projection only: no issue is deleted and shared or library-wide causes stay visible.

Decided during the build (2026-11-21): a provider with no ID from Plex and none found through the other provider is a Total Provider Lookup Failure (a missing ID is a Provider Lookup Failure), so such a show is a Partially matched show with one Scan Issues entry for that provider. An ID the provider answers with an empty show (TMDB `null`), whether Plex reported it or Shelfcheck derived it through the other provider, is treated like a 404: that provider has no catalogue, it is a Total Provider Lookup Failure, and the show is compared with the other provider. An empty show is not a 404 on the series request, so it never counts toward the not-found days. A TVDB ID that could only come from a TMDB catalogue that could not be loaded was never tried, so TVDB is not looked up rather than failing.

## Considered options

- **Any failure past 60 days ends the catalogue.** Rejected: a one-day outage would make every show whose 60 days ran out that day look unmatched.
- **One 404 past 60 days ends it.** Rejected: a temporary 404 would have the same effect.
- **Count consecutive scans instead of UTC days.** Rejected: several scans in one day would reach the limit within hours.
- **Count any 404 in a catalogue download.** Rejected: one broken season endpoint would eventually retire a real series.
