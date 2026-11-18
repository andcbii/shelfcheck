# Shelfcheck 2.6.2

Shelfcheck 2.6.2 runs one scan at a time and makes Trakt scans recover from
interruptions the same way Plex scans do.

## One scan at a time

- Only one scan runs at a time, Trakt or Plex, whether it checks the whole
  library or a single show. While a scan runs, the scan buttons on the other
  page are locked and a message says which scan is running. They unlock when
  it finishes.

## Plex scans

- If a Plex scan fails, or Plex asks Shelfcheck to slow down, the shows
  checked so far are saved straight away, so the next scan continues from
  there.
- If you change a Manual Match while a Plex scan is running, the scan now ends
  with a clear message asking you to start a new Plex scan, instead of
  appearing to run until it is reported as interrupted.

## Trakt scans

- A running Trakt scan now checks in every 15 seconds. It is reported as
  interrupted only after more than 90 seconds without checking in, as Plex
  scans are.
- When Trakt asks Shelfcheck to slow down, the pause and when it ends now stay
  on screen until the scan continues.
- The progress a Trakt scan saves part-way through is used for 6 hours, and
  only while the airing grace period is unchanged. A failed or paused scan
  saves the shows checked so far.
- Checking a single show no longer uses or saves part-way progress, and no
  longer throws away the progress of an unfinished full scan.
- The first Trakt scan after upgrading starts from your last completed results
  instead of any progress saved by an earlier version, so it is still quick.

## Upgrading

Use `andcbii/shelfcheck:2.6.2` or `andcbii/shelfcheck:latest` and retain your
existing `/config` and `/data` mounts. Images support Linux amd64 and arm64.
No configuration or database reset is required.
