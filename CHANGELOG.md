# Changelog

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
