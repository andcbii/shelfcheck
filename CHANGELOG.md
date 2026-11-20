# Changelog

## Unreleased

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

- TMDB and TVDB are judged separately for each show. A show is compared with
  whichever provider has a usable catalogue, so one provider failing, even with
  no saved data, no longer hides the other provider's missing episodes or keeps
  the show's old results and status from an earlier scan. Unmatched Shows now
  lists only shows that no provider can describe, each row giving every
  provider's cause, and a show leaves it after the next successful download.
  A show compared with one provider while the other fails keeps a Scan Issues
  entry for the failing provider; a provider with several Plex IDs has one
  entry listing each ID tried and why it failed. Rechecks from saved data keep
  each provider's status from the last scan.
- Scan Issues entries for a catalogue that could not be refreshed now show
  how old the saved catalogue is, and when TMDB or TVDB answered "not found"
  for the series itself, on how many UTC days it has, for example "404 on 7 of
  15 days · catalogue 74 days old" or "404 on 3 days · never downloaded",
  including for each ID listed in a several-ID entry. Shelfcheck keeps this
  count per provider series ID across restarts and Clear cache; only a
  complete catalogue download resets it.
- A show whose preferred catalogue cannot be loaded no longer downloads its
  fallback catalogue again on every Plex scan. The preferred catalogue is
  still retried on every full scan; the fallback is downloaded again only when
  it is older than 20 days, flagged changed by TMDB or TVDB, or has no usable
  saved copy. Editing a Manual Match or changing a catalogue override likewise
  requires only the preferred catalogue's download. The fifth-scan safeguard
  and clearing one show's cache still download the fallback. A fallback that a
  safeguard or single-show Clear cache marked just before the upgrade catches up
  under the same freshness rules.
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
