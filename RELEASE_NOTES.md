# Shelfcheck 2.5.1

Shelfcheck 2.5.1 makes failed scan checks easier to investigate.

## Scan Issues

The former Coverage Issues report is now **05 — Scan Issues**. The Plex results
warning links to the report and shows the number of current grouped issues.

Provider Lookup issues explain where a requested ID came from, the provider and
record whose lookup failed, the response, the impact on verification, and a
relevant next step. Saved provider data is identified when it supplied the ID.
Failure-time provenance survives restarts and later metadata changes; older
issues without recorded provenance show **Source unknown**.

Missing records are distinguished from rejected access, connectivity problems,
and provider outages. A 404 is reported as **record not found**, without assuming
that the record was deleted or merged. A failed lookup and the comparison it
blocks appear together as one issue, while independent failures remain visible.

Existing last-good results, provider refresh requirements, matching behavior,
and request retry and rate-limit policies are preserved. Reading the report does
not start scans or provider requests.

## Upgrading

Use Docker image `andcbii/shelfcheck:2.5.1` or `andcbii/shelfcheck:latest` and keep
your existing `/config` and `/data` mounts. No configuration or database reset is
required. Run a new Plex scan to capture detailed context for current failures.
This release does not correct external provider IDs or alter Plex metadata.
