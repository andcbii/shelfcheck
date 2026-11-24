# Shelfcheck 2.7.1

Shelfcheck 2.7.1 lets your Manual Matches decide the episodes they cover
before any automatic matching, signs in to TVDB once per Plex scan, and makes
saving Manual Match and Ignore changes more dependable. The first start
clears the saved Plex scan data once, so run a full Plex scan after
upgrading.

## Manual Matches

- A Manual Match now decides an episode it covers before anything Shelfcheck
  works out by itself: Report Missing comes first, then a Healthy Manual
  Match whose other side you directly own, then season and episode numbers,
  then automatic evidence.
- A covered episode is credited to its Manual Match and shows in the Manual
  Matches report, no longer as an Auto Match, even when its numbers or a Plex
  ID also match. Pending and Needs review Manual Matches change nothing.
- Plex scans no longer ask TVDB, Trakt or TMDB to crosswalk a TVDB episode a
  Manual Match covers, and covered episodes take no part in combined and
  split episode matching. The Manual Match health check still runs on every
  scan.
- Scan Issues entries for checks a Manual Match made unnecessary, and the
  failed provider lookups behind them, are removed when the show is next
  compared. A failed lookup another episode still needs stays.
- A Manual Match change whose recheck from saved data fails now shows as
  saved. Its shows stay pending, also after a restart, until a later recheck
  or Plex scan compares them.

## Plex scans

- A Plex scan signs in to TVDB once, after reading Plex, and the Manual Match
  recheck uses that sign-in. A failed sign-in shows once in Scan Issues with
  the Manual Match episodes it blocked folded under it; those Manual Matches
  stay saved and pending.
- A single-show scan whose Manual Match recheck changes a match's health now
  completes and compares the other shows again from saved data, instead of
  asking for a full Plex scan.
- An Ignore whose save fails no longer applies to the running scan.
- Clearing one show's cache no longer makes the next scan ask TMDB again for
  an unrelated episode's crosswalk.

## First start after upgrading

- Shelfcheck now saves provider answers by the lookup they answered, so the
  first start clears the saved Plex scan data once: downloaded provider
  catalogues, the saved library inventory, saved comparisons and the Plex
  scan cache and Resume point. The log says whether anything was cleared.
  Nothing is downloaded and no scan starts by itself.
- Run a full Plex scan after upgrading. Until then the last Plex results stay
  on screen, a single-show scan asks for a full scan first, and a Manual Match
  or catalogue override change is saved but cannot be rechecked yet.
- Kept: Manual Matches, Report Missing flags, Ignores, catalogue overrides
  and selections, credentials, Plex and Trakt settings, Trakt results and
  other Scan Issues entries. Failed provider lookup entries from before the
  upgrade are removed; the next scan reports any that still fail.

## Upgrading

Use `andcbii/shelfcheck:2.7.1` or `andcbii/shelfcheck:latest` and retain your
existing `/config` and `/data` mounts. Images support Linux amd64 and arm64.

2.7.1 upgrades the database layout, and 2.7.0 refuses a database 2.7.1 has
upgraded. Upgrading from 2.7.0 takes no new automatic backup, so to keep a
way back, stop Shelfcheck and copy `shelfcheck.db` before starting 2.7.1. To
roll back, stop Shelfcheck and restore that copy before starting 2.7.0.
