# Shelfcheck 2.5.0

Shelfcheck 2.5.0 brings Manual Matches into Reports, adds actionable Coverage
Issues, and makes local matching changes faster with targeted cached rechecks.

## Manual Matches and Matching Episodes

Open **01 — Manual Matches** to view every saved user-controlled match, including
fully collected content and matches where neither side is owned. Each complete
match appears once, with all TMDB and TVDB episodes grouped in provider panels.
Add, edit, filter, or delete matches, including bulk deletion, and inspect coverage
evidence or ownership corrections from the report.

Use **Matching Episodes** on a missing Plex episode to create a match or edit its
complete existing match without seeing unrelated matches. Saving keeps the dialog
open. Close or click outside to discard unsaved edits and return to the same Plex
results position. The former Manual Coverage header entry is removed.

## Faster rechecks and provider catalogue reuse

Saving, editing, or deleting Manual Matches and changing ownership corrections
immediately rechecks only affected shows using saved provider and library data.
These changes do not start a full scan or refetch unrelated shows. The next
user-run full Plex scan downloads fresh provider data for affected shows.

Full scans continue to check all included Plex libraries. Provider catalogues are
reused independently of comparison results, with separate TMDB and TVDB freshness
checks. Catalogues older than 60 days are refreshed; a full-scan gap over 14 days
forces a TMDB refresh. Every fifth successful full scan of the UTC day refreshes
TMDB library shows changed that day, even when already downloaded that day.

## Coverage Issues

The Plex coverage warning links to **05 — Coverage Issues**, showing known
affected shows and episodes, the provider or operation, a readable cause, and
recovery guidance. Library-wide failures appear separately. Provider freshness
issues are included even for shows without Manual Matches. The report remains
available when there are no issues, and resolved causes clear from the warning.

Last-good data and required refreshes survive provider outages and restarts.
Mutation controls are protected during scans, concurrent cached rechecks retain
their results, and explicitly empty Plex collections are handled correctly.

## Upgrading

Use Docker image `andcbii/shelfcheck:2.5.0` or `andcbii/shelfcheck:latest` and retain
your existing `/config` and `/data` mounts. No configuration or database reset is
required. Older caches without complete saved provider inputs may require an
explicit full Plex scan before cached rechecks can complete.

Reverse-proxy installations using Trakt OAuth must continue to set
`SHELFCHECK_PUBLIC_URL` to Shelfcheck's exact externally visible origin.
