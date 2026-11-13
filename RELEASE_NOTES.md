# Shelfcheck 2.5.2

Shelfcheck 2.5.2 replaces ownership corrections with **Report Missing** and fixes
provider-cache recovery and stale Plex results.

## Report Missing in Manual Matches

Each episode in a Manual Match has a **Report Missing** checkbox in the TMDB or
TVDB provider panel. Selections remain a draft until saved, with a preview of
their effect. This is a local Shelfcheck override; nothing is sent to Plex,
TMDB, or TVDB.

Complete-set Manual Matches now recognize equivalent owned content without a
second declaration. Report Missing takes precedence over collected results
across Plex libraries. Reporting a split part missing also keeps its combined
episode missing, while other parts retain their normal coverage. Many-to-many
matches require explicit selections on both provider sides or no flags.

Saved overrides survive scans, restarts, and inventory changes. Saving or
clearing them updates affected cached results without a full scan or provider
download, including TVDB specials missing from older saved catalogues.

Applying a show or season Ignore clears flags only in its scope and immediately
updates related results. Restore and expiry do not bring deleted flags back.

## Provider-cache fixes

Provider failures no longer force unrelated successful downloads to repeat.
TMDB verification recovery preserves completed work and outstanding refresh
requirements, including invalidation of stale episode relationships when
previously deferred provider changes are processed.

## Upgrading

Use `andcbii/shelfcheck:2.5.2` or `andcbii/shelfcheck:latest` and retain your
existing `/config` and `/data` mounts. Images support Linux amd64 and arm64.

Existing Manual Matches are retained. Saved ownership corrections are
permanently discarded, with Report Missing initially off; they are not converted
into missing flags. Back up `/data` before upgrading if you need to retain those
old declarations. No configuration or database reset is required.
