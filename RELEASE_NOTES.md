# Shelfcheck 2.7.0

Shelfcheck 2.7.0 checks TMDB and TVDB separately for each show, stops
comparing shows a provider has deleted, stops downloading fallback catalogues
again on every scan, and makes Trakt requests steadier in both scans.

## Plex scans and reports

- A show is compared with whichever of TMDB and TVDB can describe it. One
  provider failing no longer hides the other provider's missing episodes or
  leaves the show with old results.
- A show missing one provider is listed as partially matched, with a Scan
  Issues entry for that provider giving the cause. Unmatched Shows lists only
  shows that no provider can describe, each with every provider's cause.
- Scan Issues no longer repeats an unmatched show's own entries, and every
  Scan Issues count matches the entries shown.
- Scan Issues entries for a catalogue that could not be refreshed show how old
  the catalogue in use is and, when TMDB or TVDB reported the show as not
  found, on how many separate days.
- A show reported as not found on 15 separate days whose saved catalogue is
  more than 60 days old is treated as gone from that provider: its catalogue
  is kept but no longer compared. Outages, rate limits and sign-in failures
  never count, and one complete download makes the show usable again.
- A show whose preferred catalogue cannot be loaded no longer downloads its
  fallback catalogue again on every scan; the fallback is refreshed after 20
  days, when TMDB or TVDB flags it changed, or when it has no saved copy.
- Rechecks after a Manual Match change now work for partially matched shows.

## Trakt and providers

- A Trakt login that expires during a Plex scan is refreshed and the scan
  carries on; a login that cannot be recovered is reported once with the real
  cause.
- Both scans share one Trakt client with one token refresh and pacing from
  Trakt's own rate-limit header. Trakt requests have 30 seconds per attempt.
- A provider that asks Shelfcheck to wait more than 15 minutes is skipped for
  that scan instead of being waited out.
- The Trakt "Airing grace period" setting is now called Air-date delay, as on
  the Plex page, and the Trakt page works out which episodes have aired from
  your browser's date when it draws.

## First scan after upgrading

- Shelfcheck keeps a copy of its database as
  `shelfcheck-pre-migration-backup.db` before upgrading the database layout.
- The saved Trakt and Plex results, Resume points and scan status are cleared
  once, so the next Trakt scan and the next Plex scan are full scans.
  Settings, Ignore lists, Manual Matches, catalogue choices, Report Missing
  flags and downloaded provider catalogues are kept.
- Shows that used to wait for both providers are compared with whichever one
  works, so expect new missing-episode results and new partially matched
  entries in Scan Issues, and a shorter Unmatched Shows list.
- Counting of not-found days starts at the upgrade, so no show can be treated
  as gone for at least 15 days.

## Upgrading

Use `andcbii/shelfcheck:2.7.0` or `andcbii/shelfcheck:latest` and retain your
existing `/config` and `/data` mounts. Images support Linux amd64 and arm64.
An older Shelfcheck refuses to open a database 2.7.0 has upgraded: to roll
back, stop Shelfcheck and restore `shelfcheck-pre-migration-backup.db` as the
database before starting the older version.
