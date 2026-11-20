---
status: accepted
---

# Stop comparing a provider record only after repeated not-found answers

ADR-0003 keeps the last-good catalogue whenever a refresh fails, at any age, and ADR-0005 left shows with one ID per provider on that rule. A record the provider has really deleted therefore kept producing missing-episode results indefinitely. A single 404 cannot be trusted as deletion, because neither TMDB nor TVDB reliably signals it and a 404 can be temporary. So a series ID becomes a Gone provider record only when two independent conditions both hold: it has answered 404 on 15 separate UTC days since its last successful download, and its saved catalogue is more than 60 days old. Days count once each however many scans run, 404s before day 60 count, a successful download resets the count, and other failures (outages, 5xx, rate limits, cooldowns, sign-in failures, unreadable answers) neither count nor reset it. They keep ADR-0003's last-good behaviour indefinitely. A gone record's catalogue is kept but never compared, including in cached rechecks, and is used again after one successful download. Manual Matches on it are kept. With several Plex-reported IDs, a provider is gone for the show only when every candidate is gone. Both limits are fixed, not settings.

Each provider is judged separately. A show is compared with whatever catalogues remain usable, so one provider's failure never blocks the other's comparison, and a scan never republishes an earlier result's provider status. A show with a Total Provider Lookup Failure at one provider is a Partially matched show. It becomes an Unmatched show only when no provider has a usable catalogue, live or saved.

## Considered options

- **Any failure past 60 days ends the catalogue.** Rejected: a one-day outage would make every show whose 60 days ran out that day look unmatched.
- **One 404 past 60 days ends it.** Rejected: a temporary 404 would have the same effect.
- **Count consecutive scans instead of UTC days.** Rejected: several scans in one day would reach the limit within hours.
