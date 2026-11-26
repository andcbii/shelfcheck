# Changelog

## 2.7.3 - 2026-11-25

### Added

- Manual Match cards show each provider show as "Show Name (Year)" in the
  same font, followed by its show ID, so same-named shows such as Doctor Who
  (1963) and Doctor Who (2005) can be told apart. The year is the Show year:
  the year Plex gives the show in the latest completed full Plex scan, the
  same year the Plex page shows. A show not in Plex, or held by Plex shows
  with different years, uses its TMDB or TVDB year; with neither, the name
  shows alone.

- The Manual Matches report has two show filters, TMDB shows and TVDB
  shows: type part of a name and pick one or more shows. Picks in one filter
  mean any of them; picks in both filters must both match. While a filter is
  on, the heading reads "Manual Matches (5 of 120)"; when nothing matches,
  the page says so and offers Clear filters.

### Changed

- The Manual Matches report always lists cards in show order: TMDB show
  name, Show year (no year last), show ID, then season and episode. There is
  no sort control.

- Changing a show filter unticks matches, and Select all and bulk delete
  cover only the matches you can see. Saving a match the filters hide keeps
  the filters and says "Saved. Hidden by the current filters." Filters reset
  when you leave or reload the page.

- Only a completed full Plex scan changes Show years. Single-show scans,
  rechecks and Clear cache keep them, and the Plex page now keeps the full
  scan's year after a single-show scan. A completed full scan makes one
  extra show lookup (at most 3 at a time) for each Manual Match show it
  doesn't otherwise visit.

### Upgrade notes

- From 2.7.2, nothing migrates. Until the first completed full Plex scan,
  existing Manual Matches show names without years, except matches you save,
  which pick up their TMDB or TVDB year when saved.

- From 2.7.1, the first start also makes the 2.7.2 database upgrade, which
  takes no new automatic backup, and 2.7.1 refuses the upgraded database. To
  keep a way back, stop Shelfcheck and copy `shelfcheck.db` before starting
  2.7.3; to roll back, stop Shelfcheck and restore that copy before starting
  2.7.1.


## 2.7.2 - 2026-11-24

### Added

- The Trakt and Plex pages show a progress box while a scan runs: the shows
  being checked right now, each with its step in plain words ("Getting the
  episode list from TVDB"), over a progress bar. During a rate-limit pause
  its heading reads "Waiting" and a notice names the provider, the time the
  scan resumes and a countdown, for example "Paused: TVDB rate limit.
  Resumes at 21:14."

- On the Plex page the box also shows how far the scan's preparation has
  got, before and alongside the comparison counter: "Reading Plex library
  N/M", counting every Plex record read or failed out of the whole library
  (also for a single-show scan), and "Preparing TMDB and TVDB episode lists
  N/M", counting shows whose lists were downloaded, reused or failed. Both
  lines show together while both run. The scan button reads "Preparing
  scan…" until the comparisons start, and "Removing unused Manual Match
  members…" shows while a scan finishes. A scan with no shows to compare
  says so once its library is read.

- The Trakt page shows each show's poster: the Trakt poster, or the matching
  Plex show's artwork when Trakt has none or it fails to load, and otherwise
  the show's initials.

### Changed

- Manual Matches no longer have a health. A Plex scan no longer rechecks
  every Manual Match member at TMDB and TVDB before comparing, which took
  about 55 seconds of every full scan before the first show. Every saved
  Manual Match can grant coverage, so a provider outage can no longer stop a
  match covering and show owned episodes as missing. The Manual Matches
  report and the Matching Episodes editor no longer show Healthy, Pending or
  Needs review badges, the health filter or health summaries; selection,
  paging and delete work over every saved Manual Match. Scan Issues no
  longer lists member-verification entries. Saving or editing a Manual Match
  still looks every episode up at its provider and shows the preview, so a
  match still starts from real provider records.

- A Manual Match now covers one way. When you own every TMDB episode in a
  match, it covers the match's missing TVDB episodes. Owning its TVDB
  episodes never covers a TMDB episode, however complete the TVDB side: TMDB
  is the library's official order, so a TMDB episode counts as collected
  only by its own season and episode numbers or its own TMDB identity. A
  TMDB episode you hold only through the TVDB episodes of a Manual Match now
  shows as missing. Report Missing, the complete-set rule, direct
  ownership, ignored-show evidence and the Incomplete combined episode work
  as before, in scans and cached rechecks alike.

- After a Plex scan saves its report, it removes gone members from their
  Manual Matches. A member is a candidate only when its own provider show
  was downloaded fresh and complete in that scan, the show's comparison
  completed with a fresh result, and the downloaded list lacks the episode.
  A reused, saved, failed, incomplete or fallback catalogue never makes a
  candidate. The scan then looks each candidate up at its provider and
  removes it only when the provider confirms the episode gone: a 404, a TVDB
  episode now in another series, or a TMDB episode number that now names
  another episode. Any other answer keeps the member, and a later scan can
  try again. The removals are saved together as one Manual Match change,
  each removal is written to the Plex scan log (there is no Scan Issues
  entry), a Manual Match left without a TMDB or TVDB episode is deleted, and
  the other members keep their Report Missing flags. The affected shows are
  then rechecked from saved data before the scan reports completion. A scan
  that fails, is interrupted or is stopped before its report is saved
  removes nothing, and a cached recheck never removes members.

  A provider that deletes an episode and re-adds it under a new ID loses
  that member at the next fresh download; the re-added episode shows as
  missing until you edit the match to add it.

- The first start after upgrading (migration 8) removes each Manual Match's
  saved health and health message, every member-verification Scan Issues
  entry (and only the links to them from other entries), and the health
  saved in the last Plex report, and clears the Plex Resume point, whose
  shows were compared while Pending and Needs review matches covered
  nothing. The log says when it changed anything. Downloaded catalogues and
  the last Plex report are kept, so nothing is downloaded again and no scan
  starts by itself. Manual Matches that were Pending or Needs review cover
  from the next Plex scan, which is an ordinary scan.

- Plex scans prepare faster. The Plex library is read 8 requests at a time
  with no gap between them; Plex rate limits, Retry-After and outages are
  still honoured, and other Plex requests keep their spacing. The TMDB and
  TVDB change lists are fetched while the library is read, and each show's
  TMDB and TVDB episode lists start downloading as soon as its Plex data is
  in. Owned and missing episodes are still decided only once the whole
  library is read, so results are the same as before given the same
  provider answers. Comparisons still run 3 shows at a time, and TMDB, TVDB
  and Trakt pacing is unchanged.

- The Plex page keeps showing its last completed report, shows and
  incomplete coverage groups alike, under the progress box while a scan
  runs. A completed scan replaces it in full; a failed scan keeps it. A
  first-ever scan shows only the progress box.

- While a scan of the other kind runs, the Trakt or Plex page's scan button
  reads "Another scan is in progress" and is shown locked, with the line
  naming the running scan under it, so a Trakt scan and a Plex scan never
  run together.

## 2.7.1 - 2026-11-23

### Changed

- Shelfcheck now saves what TMDB, TVDB and Trakt said about a show or episode
  by the lookup it answered rather than by the web address it was requested
  from. Saved data in the old format cannot be read, so the first start after
  upgrading clears the saved Plex scan data once: downloaded provider
  catalogues, the saved library inventory, saved comparisons with their
  provider answers, and the Plex scan cache and Resume point. The log says
  whether anything was cleared. Nothing is downloaded and no scan starts by
  itself.

  Run a full Plex scan after upgrading. It downloads every catalogue again and
  asks the providers again for the episode crosswalks it needs. Until then,
  the last Plex results stay on screen, a single-show scan asks for a full scan
  first, and a Manual Match or catalogue override change is saved but cannot
  be rechecked yet; Scan Issues says the saved inputs are incomplete.

  Scan Issues entries for failed provider lookups from before the upgrade are
  removed, since they name lookups in the old format; the next scan reports
  any that still fail. Other entries keep their other causes. Some episode
  check entries may stay on the Scan Issues page without their failed-request
  link until the next full scan.

  Kept through the upgrade: Manual Matches, Report Missing flags, Ignores,
  catalogue overrides and selections, credentials, Plex and Trakt settings,
  Trakt results, the record of series reported as not found, full-scan
  counts, provider change-feed positions, pending fifth-scan safeguards and
  every other Scan Issues entry.

- Saving, editing or deleting a Manual Match, changing only its Report
  Missing flags, and applying an Ignore that clears Report Missing flags now
  show as saved when the change was saved but the recheck of the Plex results
  from saved data then failed. Before, a Manual Match change showed "provider
  unavailable" and an Ignore showed an error, although the change was saved
  and no provider was contacted. The Plex page now shows the comparison
  pending notice and keeps the last results until a later recheck or Plex
  scan succeeds.

  The shows of a change whose recheck failed now stay pending until they are
  rechecked, also after a restart. Shelfcheck saves the Manual Match episodes
  each change affects together with the change, and every later recheck
  compares their shows too. Before, a later change that rechecked only other
  shows cleared the pending notice while the failed change's shows kept their
  last results. The notice now clears only when no saved change is left
  unrechecked. A recheck or full Plex scan that could not compare one of a
  change's shows, or ran without a complete library inventory, keeps that
  change unrechecked; a single-show or failed scan leaves the notice. A database upgraded with the notice already showing has no
  such saved episodes, so its notice clears with the next recheck or full
  Plex scan, as before.

  One limit remains: the note that the affected shows need fresh downloads on
  the next scan is written by the recheck, so a recheck that failed early may
  not have written it until a later recheck does.

  During a Plex scan, a malformed Manual Match request (an invalid ID or JSON)
  is now refused as invalid rather than because a scan is running. Every
  well-formed Manual Match change is still refused while a scan runs.

- Ignore rules over the saved Trakt and Plex results now live in one place,
  apart from the code that stores them. Ignoring a show still deletes its
  saved results, so a Restore cannot bring them back, and an Ignore applied
  during a scan still applies to that scan. Results an older version kept for
  an ignored show are now removed when Shelfcheck first reads or changes its
  saved scan state rather than when the database opens, so a temporary Ignore
  that ends in between keeps those older results.

- A Manual Match now decides an episode it covers before anything Shelfcheck
  works out by itself. Each episode is decided by Report Missing first, then a
  Healthy Manual Match whose other side you directly own, then season and
  episode numbers, then automatic evidence. A covered episode is credited to
  its Manual Match even when its numbers or a Plex ID also match: it shows in
  the Manual Matches report and no longer as an Auto Match. Pending and Needs
  review Manual Matches change nothing.

  A Plex scan no longer asks TVDB, Trakt or TMDB to crosswalk a TVDB episode
  a Manual Match covers, and covered episodes take no part in combined and
  split episode matching. The Manual Match health check still runs on every
  scan.

  Scan Issues entries for crosswalk and combined or split checks that a
  Manual Match made unnecessary, and the failed provider lookups behind them,
  are removed when the show is next compared. A failed lookup another episode
  still needs stays. Saved results change as each show is compared again; no
  scan is needed only for this change.

### Fixed

- A Plex scan now signs in to TVDB once, after reading Plex, and its Manual
  Match recheck uses that sign-in. When the sign-in fails, for any reason (a
  refused login, a network error, an unreadable answer, a too-long rate-limit
  wait or a missing token), Scan Issues shows the TVDB sign-in failure once
  with every Manual Match TVDB episode it blocked folded under it, also after
  a restart or a later scan failure. Those Manual Matches stay saved and
  pending, no TVDB episode request is sent for them, and their TMDB episodes
  are still checked. The TVDB sign-in issue now says Manual Match episodes
  could not be verified as well.

  Before, the recheck signed in on its own before reading Plex: a failed
  recheck sign-in left its member issues pointing at a sign-in issue that was
  never recorded, or that a second, successful sign-in later cleared, so they
  showed one by one; and they were grouped only when the sign-in failed with
  an HTTP error.

  A scan that fails reading Plex now sends no TVDB sign-in and leaves earlier
  TVDB sign-in and Manual Match member issues as they were; the scan failure
  itself is still recorded.

  A single-show scan whose Manual Match recheck changes a match's health, for
  example when its TVDB sign-in succeeds after a full scan's failed, now
  completes. It also compares every other show again with the new health,
  from saved data, downloading a show's catalogues only when its saved data
  cannot be used, so no result from before the change is kept. If a show
  still cannot be compared, the scan stops and the earlier results stay, with
  the reason in Scan Issues. Before, it stopped and asked for a full Plex
  scan.

- An Ignore whose save fails no longer applies to the running scan: the scan
  is marked only once the rule and the removal of its saved results are both
  saved, and a failed save leaves the rule, the saved results and any Report
  Missing cleanup as they were.

- Clearing one show's cache no longer makes the next scan ask TMDB again for
  an unrelated episode's crosswalk. A TMDB series lookup for a TVDB series and
  a TMDB episode lookup for a TVDB episode with the same number were saved
  under the same name, so they could also share a failure; they are now kept
  apart.

## 2.7.0 - 2026-11-21

### Fixed

- A Plex scan run now refreshes a Trakt login that expires part-way through
  and carries on. Before, every Trakt episode identity check after the expiry
  failed and was reported against its own episode.
- When the Trakt login cannot be recovered, a Plex scan run reports one Trakt
  login Coverage Issue with the real cause, stops asking Trakt for the rest of
  the run, and keeps its TMDB checks, instead of a failure for every episode.
  A failed token refresh never overwrites the saved Trakt login, and the issue
  clears once a Trakt lookup succeeds again.

### Changed

- Shelfcheck now checks TMDB and TVDB separately for each show. A show is
  compared with whichever provider can describe it, so one provider failing,
  even with no saved data, no longer hides the other provider's missing
  episodes or leaves the show with old results from an earlier scan. A show
  missing one provider is listed as partially matched, with a Scan Issues
  entry for that provider giving the cause; when Plex links the show to
  several IDs at that provider, the one entry lists each ID, why it failed and
  how old its saved catalogue is. A provider with no ID from Plex and none
  found through the other provider, or an ID TMDB answers with an empty show,
  now counts as that provider failing. Rechecks from saved data after a Manual
  Match change keep each provider's status from the last scan, and now work
  for partially matched shows too.

  Unmatched Shows now lists only shows that no provider can describe, each
  with every provider's cause, and a show leaves it after its next successful
  download. Scan Issues no longer repeats such a show's own entries, and every
  Scan Issues count matches the entries shown; causes shared with other shows,
  such as a TVDB sign-in failure, stay listed with every show they affect.

  Scan Issues entries for a catalogue that could not be refreshed show how old
  the catalogue in use is and, when TMDB or TVDB reported the show itself as
  not found, on how many separate days it has done so. A show reported as not
  found on 15 separate days whose saved catalogue is more than 60 days old is
  treated as gone from that provider: its saved catalogue is kept but no
  longer compared, in scans or in rechecks, so a show the provider has deleted
  stops producing missing episodes. Only a complete download resets the count,
  which survives restarts and Clear cache, and one complete download makes the
  show usable again. Outages, rate limits and sign-in failures never count and
  still keep the last saved catalogue at any age, and Manual Matches on a gone
  show stay saved. A show with several Plex IDs for a provider chooses among
  them as before; when none loads or has a catalogue from the last 60 days, it
  now compares the most recently saved catalogue that is not gone instead of
  none.
- A show whose preferred catalogue cannot be loaded no longer downloads its
  fallback catalogue again on every Plex scan. The preferred catalogue is
  still retried on every full scan; the fallback is downloaded again only when
  it is older than 20 days, flagged changed by TMDB or TVDB, or has no usable
  saved copy. Editing a Manual Match or changing a catalogue override likewise
  requires only the preferred catalogue's download. The fifth-scan safeguard
  and clearing one show's cache still download the fallback. A safeguard's
  download waits, without showing as a problem, while its catalogue is not the
  one compared, and happens when it is compared again; it is dropped once a
  complete Plex scan no longer reports that series for the show. A fallback
  flagged for download just before this update may instead wait for its usual
  20-day refresh.
- Both scans send Trakt requests through one provider client: one token
  refresh is shared by every request that needs it, and Trakt requests are
  paced from Trakt's own rate-limit header in both scans.
- A provider cooldown longer than 15 minutes, asked for by Plex, TMDB, TVDB or
  Trakt (a rate limit, a server outage or a rate-limit reset), makes that
  provider unavailable for the scan run instead of waiting it out. A Plex scan
  run continues with its other providers; a Trakt scan run fails at once with
  "Trakt asked Shelfcheck to wait N minutes. Start the scan again after that
  to resume." and resumes from its Resume point. A later scan run honours
  whatever remains of the cooldown until Shelfcheck restarts.
- Trakt requests now have 30 seconds per attempt, including reading the
  response.
- On the first start after this upgrade, Shelfcheck keeps a copy of its
  database as shelfcheck-pre-migration-backup.db, next to the database, before
  it upgrades the database layout. An older Shelfcheck refuses to open a
  database a newer one has upgraded. To roll back, stop Shelfcheck and restore
  that copy as the database before starting the older version.
- After this upgrade, the saved results, Resume point and scan status of both
  the Trakt and Plex pages are cleared once. Each page shows its usual prompt
  to run a scan, and the next Trakt scan and the next Plex scan are full scans.
  Settings, Ignore lists, Manual Matches, catalogue choices, Report Missing
  flags and downloaded provider catalogues are kept.
- The Trakt "Airing grace period" setting is now called Air-date delay, as on
  the Plex page. A Trakt scan saves every missing episode with its air date,
  and the Trakt page decides which have aired as it draws, from the browser's
  local date: an episode appears on the day its delay ends with no new scan,
  and changing the delay redraws the page at once without re-checking shows or
  discarding a Resume point. Trakt results saved before this left out episodes
  still inside the delay, so the saved Trakt results and Trakt Resume point are
  cleared once, and the next Trakt scan is a full scan. Trakt Settings and
  Ignore lists are kept.

## 2.6.2 - 2026-11-18

### Changed

- Allow one scan run at a time across Trakt and Plex, full or single-show. While
  a scan run is active, the other page's scan controls are locked with a
  message naming the running scan, and a refused start returns that message
  with HTTP 409 instead of starting a second scan.
- A Plex scan run that fails, or that a Plex rate-limit pause interrupts, now
  saves a Resume point of its completed shows straight away.
- A Plex scan run whose Manual Matches change while it runs now ends with a
  clear error asking for a new Plex scan, instead of staying running until it
  reads as an Interrupted scan.
- Trakt scan runs report a heartbeat every 15 seconds and are recognised as an
  Interrupted scan only after more than 90 seconds without one, the same rule
  as Plex. A Trakt rate-limit pause and its resume time now stay on the status
  through progress updates until the pause ends.
- Trakt Resume points record when they were saved, a format version and the
  airing grace period. A full scan run resumes only from one with the current
  version and grace period that is under 6 hours old; any other is discarded
  and the run falls back to the saved report and scan cache. Resume points
  saved before 2.6.2 are discarded once, on the first Trakt scan run after
  upgrading.
- Trakt single-show checks start from the saved report, never load or create a
  Resume point, and leave a saved full-run Resume point in place without the
  checked show.

## 2.6.1 - 2026-11-17

### Changed

- Run on Node.js 26, the current long-term support line, in the Docker image
  and CI. Local development now needs Node.js 26 or newer.
- Check every pull request by starting the image on linux/amd64 and
  linux/arm64 and confirming pages, static files and saved settings work.
- Dependabot no longer proposes Node major versions; those upgrades are
  planned work.

## 2.6.0 - 2026-11-17

### Added

- Keep every TMDB and TVDB series ID Plex attaches to a show as a candidate and
  compare against the lowest ID by default, independent of Plex GUID order.
- Add a Multiple Provider IDs report to choose which series ID each provider
  uses, saved per show and kept when the cache is cleared; saving rechecks the
  show immediately from saved data.
- Show a note on results that use a show with several IDs, with a Review IDs
  link to its report entry.

### Changed

- When the chosen series cannot be loaded, keep using its saved catalogue for
  up to 60 days, then fall back to the lowest usable ID until it loads again.
  Shows with several IDs refresh their catalogue once it is older than 20 days.
- Upgrade Next.js to 16.4.6 (fixes GHSA-mfr8-8qww-v76h and
  GHSA-vc7v-qv4w-wrv8), React to 19.3.1, Tailwind CSS to 4.3.5 and TypeScript
  to 6.0.3, with other build and lint tooling updates.
- Pin GitHub Actions by commit SHA and the Node 24 base image by digest, with
  weekly Dependabot update pull requests.

## 2.5.5 - 2026-11-15

### Changed

- Show Manual Matches as compact cards with grouped episode columns and edit or
  add matches in a focused popup with keyboard focus handling.
- Close the editor after saving, show a brief Saved confirmation, ask before
  discarding unsaved changes, and pause saving while a Plex scan runs.
- Confirm single and bulk deletions, and show bulk actions only when matches
  are selected.
- Use Manual Match wording consistently in the report, editor and server messages.
- Add support and private security reporting guidance, and keep local agent
  instructions, runtime context and generated artifacts out of published sources
  and Docker build contexts.

## 2.5.4 - 2026-11-13

### Fixed

- Refresh needed TMDB episode crosswalks on a later UTC day, independently of
  show change feeds, so added or corrected external IDs update episode coverage.
- Share crosswalk evidence across show comparisons while evaluating ownership
  against the current library inventory.
- Keep failed refreshes rejected through offline Manual Match rechecks and
  restarts, and preserve recovered evidence across repeated offline rechecks.

## 2.5.3 - 2026-11-13

### Fixed

- Isolate malformed provider records and episode matching failures so usable
  siblings and independent matching methods still complete.
- Recover unusable TVDB episode titles from per-episode English translations,
  save recovered titles, and retry unresolved lookups on later requested scans.
- Keep unresolved checks visible in Scan Issues even when other evidence
  establishes coverage; preserve normal Plex missing results and offline rechecks.
- Preserve saved episode numbering, partial Trakt validation failures and retries,
  unresolved combined/split causes, and last-good results for unusable catalogues.

## 2.5.2 - 2026-11-12

### Added

- Per-episode Report Missing checkboxes in Manual Match provider panels, with
  draft previews and distinct explicit and incomplete combined-episode statuses.
- Report Missing support for one-to-one, combined/split, and many-to-many matches,
  including TVDB specials absent from older cached catalogues.

### Changed

- Complete-set Manual Matches recognize equivalent owned content without a second
  ownership declaration. Report Missing overrides every collected determination
  across Plex libraries and updates affected cached results immediately.
- Replace ownership corrections with Report Missing. Existing Manual Matches are
  retained; old corrections are discarded without conversion to missing flags.
- Applying show or season Ignore removes Report Missing flags only in its scope;
  Restore and expiry do not recreate them.

### Fixed

- Refresh displayed results after Ignore cleanup and suppress missing badges for
  ignored members of surviving coverage groups.
- Isolate provider cache failures, preserve progress during TMDB verification
  recovery, and invalidate stale identity relationships for retained changes.

## 2.5.1 - 2026-11-11

### Changed

- Rename Coverage Issues to Scan Issues and clarify the Plex results warning.
- Explain provider lookup failures with the requested record, failing provider,
  ID source chain, cached-data provenance, response, impact, and recovery guidance.
- Group a failed lookup and its dependent comparison impact into one counted issue,
  while retaining independent failures and consistent report and warning counts.

### Fixed

- Distinguish missing provider records from access and connectivity failures.
- Preserve failure-time ID sources across restarts and metadata changes; older
  issues without recorded provenance explicitly show Source unknown.

## 2.5.0 - 2026-11-11

### Added

- Manual Matches report with complete episode-set rows, provider panels, health
  filtering, editing, bulk deletion, coverage evidence, and ownership corrections.
- Coverage Issues report identifying affected content, provider failures, and
  recovery guidance, linked directly from the Plex coverage warning.
- Focused Matching Episodes dialog with complete existing-match editing,
  outside-click dismissal, draft discard, and preserved Plex results position.

### Changed

- Move Manual Coverage management from the header to report 01, Manual Matches;
  renumber existing reports and add report 05, Coverage Issues.
- Reuse saved provider catalogues independently of Plex comparisons. Manual Match
  and ownership-correction changes immediately recheck affected cached results
  without rescanning unrelated shows, and require fresh provider data next full scan.
- Apply independent provider freshness checks, maximum catalogue ages, and a
  targeted TMDB refresh on every fifth successful full scan of the UTC day.

### Fixed

- Preserve last-good results and refresh obligations through provider failures
  and restarts, with structured coverage and freshness diagnostics.
- Protect mutations during active scans and preserve concurrent cached rechecks.
- Accept explicitly empty Plex collections without retaining stale inventory.

## 2.4.0 - 2026-11-08

### Added

- Persistent manual Plex episode coverage mappings between complete TMDB and
  TVDB episode sets, including different seasons and parent shows.
- Episode URL and provider-qualified ID previews, mapping creation and editing,
  ownership corrections for ambiguous Plex items, and grouped incomplete results.
- Provider health states, reviewed repair, and explicit bulk cleanup across pages
  in the Manual Coverage manager.
- Revision-aware queued rechecks and pending feedback after mapping changes,
  preserving existing automatic matching and separate Trakt scans.

## 2.3.1 - 2026-11-06

### Fixed

- Delayed Plex report responses cannot restore whole-show results or caches
  removed by Ignore. Restore and expiry require a new scan to obtain results.
- Older initial report loads and aborted scan polls cannot replace newer scan
  results. Saved ignores also prune reports that arrive before preferences load.
- Added client regression coverage for Ignore, delayed report delivery, Restore,
  expiry, and fresh scans after the ignore ends.

## 2.3.0 - 2026-11-06

### Added

- Temporary whole-show and season ignores for 30 days, 90 days, or six calendar
  months in Plex and Trakt, alongside permanent ignores.
- Expiry dates, duration changes, and immediate Restore in Ignored Shows.

### Fixed

- Trakt login and token refresh identify Shelfcheck with its versioned User-Agent
  to avoid Cloudflare blocking the OAuth token request.
- Whole-show ignores immediately remove saved results, caches, and checkpoints,
  including results written by a scan that was already running.
- Existing permanent ignores are normalized on upgrade so Restore cannot expose
  previously retained results.

### Security

- Updated Next.js and image-processing dependencies to patched releases.

## 2.2.0 - 2026-08-15

### Added

- Added exact TMDB episode metadata and provider links to Plex auto-match
  reports, plus shared report pagination and a local TVDB asset.
- Added regression coverage for cache compatibility, checkpoint pairing,
  provider rate limits, public-origin handling, and report links.

### Changed

- OAuth redirects now use the explicitly configured `SHELFCHECK_PUBLIC_URL`
  instead of trusting forwarded host headers. Reverse-proxy deployments must set
  this value to Shelfcheck's externally visible origin.
- Plex and Trakt now share race-safe scan polling and bounded progress display.
- Plex provider requests honor provider-wide `Retry-After` pauses and fail
  promptly when a provider requests an excessive cooldown.
- Plex preferences are saved as validated partial patches.
- Plex poster proxying is restricted to image thumbnail paths and a 10 MB limit.

### Fixed

- Fixed targeted Plex rescans carrying incompatible cache entries, ignored or
  deleted shows, or stale checkpoint results into later reports.
- Targeted Plex rescans now reject incompatible caches synchronously with an
  actionable conflict response instead of starting a scan that cannot succeed.
- Fixed failed episode identity lookups and warned results becoming reusable
  cached answers.
- Fixed provider change feeds missing updates made during the previous scan.
- Fixed scan polling delays retaining abort listeners after normal completion.
- Fixed invalid Trakt show IDs falling through to whole-cache deletion.

## 2.1.0 - 2026-08-10

### Added

- Added Plex reports for automatically reconciled episodes, unresolved shows,
  and unusual TMDB/TVDB provider relationships.
- Added library-wide Plex episode identity indexing so separately managed Plex
  shows can satisfy explicit cross-provider episode links.

### Changed

- Explicit TMDB and TVDB external-ID links are authoritative when Plex owns the
  exact linked episode; parent-series agreement is no longer required.
- Provider-match reporting retains many-to-one, one-to-many, and conflicting
  parent-series relationships for review instead of rejecting explicit links.
- Plex shows with the same complete TMDB/TVDB identity are audited as one
  combined library holding while distinct TMDB series remain separate.

### Fixed

- Fixed false missing episodes when multiple TMDB series map into one TVDB
  series, including the 1993 and 2020 Animaniacs records.
- Fixed split sequel or continuation libraries, including Baseball and The
  Tenth Inning, where provider databases assign different parent series.

## 2.0.1 - 2026-08-09

### Fixed

- Trakt authorization now uses the public HTTPS origin forwarded by a reverse
  proxy instead of the container's internal HTTP origin.

## 2.0.0 - 2026-08-09

### Added

- Added a complete Plex library audit with TMDB, TVDB, IMDb, and Trakt episode crosswalks.
- Added optional automatic compound-episode reconciliation, enabled by default.
- Added concurrent Plex show processing with conservative provider pacing, resumable checkpoints, diagnostics, and concurrent heartbeat status.
- Added independent Plex preferences for ignored shows, unaired episodes, airing offsets, cache management, and diagnostics.

### Changed

- Ignored Plex and Trakt shows are now excluded before provider work so future scans skip their API calls.
- Provider timing distinguishes request queueing, network work, and rate-limit waits.
- Split scan concurrency, provider transport, inventory, cache policy, episode reconciliation, shared UI controls, and Trakt data normalization into focused modules.
- Persisted preferences are validated and stored JSON is read through safe typed boundaries.
- Normalized repository line endings and removed unused starter assets.

### Fixed

- One owned compound episode can satisfy multiple equivalent TVDB episode records when corroborating evidence is strong.
- Plex episodes without a usable air date are hidden when **Hide unaired episodes** is enabled.
- Concurrent scan heartbeats now report every active show instead of presenting one worker as the entire scan.
- TMDB-owned episodes remain satisfied when provider season/episode coordinates differ.
- Scan progress updates preserve active heartbeat and provider rate-limit state.
- Expired Trakt authorization fails immediately after refresh instead of entering the retry ladder.
- Plex polling now cancels on navigation and reports status-loading failures instead of leaving a stuck scan indicator.
- Tagged releases now pass application and container verification before publishing.

## 1.3.0 - 2026-08-08

### Added

- Added a first-visit search chooser with separate Trakt and Plex destinations.
- Added a persistent Trakt/Plex switcher to move between collection sources.
- Added a Plex placeholder page for the upcoming Plex library audit.
- Added Trakt Authorization Code login, automatic access-token refresh, and logout.

### Changed

- Replaced manual access-token entry with Trakt application credentials and browser authorization.
- Made the active Trakt sign-in state explicit in the application header.
- Moved the existing Trakt collection audit to `/trakt`.
- Ignored shows now use server state exclusively instead of legacy browser storage.

### Fixed

- Menus now close when clicking outside them or pressing Escape.
- Trakt authorization callbacks now return to the Trakt audit after the landing page was introduced.

## 1.2.0 - 2026-08-07

### Added

- Quick Scan compares collected and aired episode counts before requesting show details.
- Deep Scan reuses cached results and rescans shows whose collection inventory, aired count, Trakt update timestamp, or grace-period setting changed.
- Deep Scan verifies each incomplete episode's Trakt air date before applying the configured grace period, including a zero-day grace period.
- Settings can clear the shared Quick and Deep scan cache.
- Scan progress reports Trakt rate-limit pauses and resumes automatically.
- Diagnostic logs include request timing, scan planning, cache reuse, and rate-limit events.
- Scan progress is stored separately from report data, while resumable checkpoints are saved in batches and before pauses or failures.
- CI now audits, lints, discovers all TypeScript tests recursively, and builds every push and pull request.
- Version tags create a GitHub release and publish matching multi-architecture images to Docker Hub.
- Scan timestamps are stored as UTC ISO values and displayed in the browser's local timezone; polling now cancels cleanly when the page unmounts.
- Failed or incomplete air-date responses now keep incomplete episodes visible and leave the show uncached so a later scan retries it.
- The supported local, CI, build, and container runtime is now Node.js 24.

### Changed

- Removed calendar scheduling and `/sync/last_activities` from the scan path.
- Renamed the standard and detailed scan actions to Quick Scan and Deep Scan.
- Removed obsolete OpenAI Sites, Cloudflare Worker, D1, Drizzle, and Vite scaffolding from the Docker-based application.

### Security

- Updated the application dependency chain to patched releases.
- Added explicit ignore rules for local credential files.
