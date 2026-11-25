# Shelfcheck 2.7.2

Shelfcheck 2.7.2 makes Plex scans start comparing sooner, shows live
progress on the Trakt and Plex pages, and lets every Manual Match cover its
episodes without a health check. The first start removes the saved Manual
Match health and clears the Plex Resume point; your catalogues and last
Plex report are kept, so nothing is downloaded again and the next Plex scan
is an ordinary scan.

## Faster Plex scans

- The Plex library is read 8 requests at a time with no gap between them.
  Plex rate limits and outages are still honoured.
- The TMDB and TVDB change lists are fetched while the library is read, and
  each show's TMDB and TVDB episode lists start downloading as soon as its
  Plex data is in.
- A scan no longer spends about 55 seconds rechecking every Manual Match at
  TMDB and TVDB before its first show.
- Results are the same as before: owned and missing episodes are still
  decided only once the whole library is read.

## Scan progress

- The Trakt and Plex pages show a progress box with the shows being checked
  right now and what each is waiting for. During a rate-limit pause it
  names the provider, the time the scan resumes and a countdown.
- On the Plex page the box shows "Reading Plex library N/M" and "Preparing
  TMDB and TVDB episode lists N/M" before and alongside the comparison
  counter. The scan button reads "Preparing scan…" until comparisons start,
  and "Removing unused Manual Match members…" shows while a scan finishes.
- The Plex page keeps your last report on screen during a scan. A completed
  scan replaces it; a failed scan keeps it.
- The Trakt page shows show posters, from Trakt or else from the matching
  Plex show.
- While a scan of the other kind runs, the scan button reads "Another scan
  is in progress", so a Trakt scan and a Plex scan never run together.

## Manual Matches

- Manual Matches no longer have a health. The Healthy, Pending and Needs
  review badges, the health filter and the member-verification Scan Issues
  entries are gone. Every saved Manual Match can grant coverage, so a
  provider outage no longer makes owned episodes show as missing.
- Matches cover one way. Owning every TMDB episode of a match covers its
  missing TVDB episodes. Owning TVDB episodes never covers a TMDB episode,
  so a TMDB episode you hold only through a match's TVDB episodes now shows
  as missing.
- After a Plex scan saves its report, it removes a Manual Match member when
  a fresh, complete download of that member's own show no longer lists the
  episode and the provider confirms it deleted it. Each removal is written
  to the Plex scan log, a match left with an empty side is deleted, and the
  affected shows are rechecked from saved data. Other members keep their
  Report Missing flags.
- Unchanged on purpose: saving or editing a Manual Match still checks every
  episode at its provider, a reused or failed download never removes a
  member, and rechecks after your own changes never remove anything.

## First start after upgrading

- Shelfcheck removes each Manual Match's saved health and every
  member-verification Scan Issues entry, and clears the Plex Resume point.
  The log says when it changed anything.
- Kept: Manual Matches and their Report Missing flags, downloaded
  catalogues, the last Plex report and every other setting and result.
  Nothing is downloaded and no scan starts by itself.
- Manual Matches that were Pending or Needs review cover from the next Plex
  scan.

## Upgrading

Use `andcbii/shelfcheck:2.7.2` or `andcbii/shelfcheck:latest` and retain your
existing `/config` and `/data` mounts. Images support Linux amd64 and arm64.

2.7.2 upgrades the database layout, and 2.7.1 refuses a database 2.7.2 has
upgraded. Upgrading from 2.7.1 takes no new automatic backup, so to keep a
way back, stop Shelfcheck and copy `shelfcheck.db` before starting 2.7.2. To
roll back, stop Shelfcheck and restore that copy before starting 2.7.1.
