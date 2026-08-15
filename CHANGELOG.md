# Changelog

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
