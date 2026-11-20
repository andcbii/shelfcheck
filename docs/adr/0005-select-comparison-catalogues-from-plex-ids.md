---
status: accepted
---

# Select comparison catalogues predictably from Plex series IDs

> Amended by [ADR-0006](0006-gone-provider-records.md): ordinary selection is unchanged, but when no candidate qualifies the most recently saved catalogue that is not gone is used, and the provider is gone only when every candidate is gone. Single-ID shows follow ADR-0006, not only ADR-0003.

Plex can identify one show with multiple series IDs from the same provider. Taking the last GUID makes missing results depend on list ordering. Select the lowest numeric ID independently for each provider, with a saved user override limited to Plex-reported candidates, and expose the selection in a Multiple Provider IDs report and linked results notice. Compare one catalogue per provider and retain existing episode matching, including coordinate matching; series selection does not establish episode equivalence.

Keep the user's preferred catalogue distinct from the catalogue currently usable. Neither provider reliably signals deletion: a 404 can be temporary or a service issue. So any failure to load the preferred series makes it unavailable, and its saved catalogue stays in use while it is 60 days old or less, the existing refresh boundary. After that, use the lowest remaining usable Plex candidate without erasing the preference, and resume the preferred catalogue when it loads again. To keep that window wide, the catalogue in use for a provider with several candidates is refreshed once older than 20 days. While the preferred catalogue is unavailable it is retried on every full scan, but its open refresh obligation requires only the preferred catalogue: a fallback in use is downloaded again only under these freshness rules, unless the fifth-scan safeguard or a single-show Clear cache requires it. A successful Plex inventory observation removing any candidate clears that provider's override; additions, reordering and outages preserve it. This preserves the user's choice through provider-side failures while letting Plex control candidate membership. Shows with one ID per provider keep the ADR-0003 failure behavior.

Overrides are keyed by the show's existing group identity rather than a new stable identity. This accepts that reordering a merged group's Plex records can change that identity and lose the override, in exchange for not rekeying every show's existing state.

The [specification](../specs/multiple-provider-ids.md) records the product-owner timeline, removal semantics, report behavior, shared scan/recheck integration, and acceptance criteria. This narrowly revisits ADR-0002's proposed exclusion of a primary-catalogue UI for multiple Plex-reported IDs; it does not add arbitrary show mappings or change the ADR-0001 episode-coverage rules.
