---
status: proposed
---

# Select comparison catalogues predictably from Plex series IDs

Plex can identify one show with multiple series IDs from the same provider. Taking the last GUID makes missing results depend on list ordering. Select the lowest numeric ID independently for each provider, with a saved user override limited to Plex-reported candidates, and expose the selection in a Multiple Provider IDs report and linked results notice. Compare one catalogue per provider and retain existing episode matching, including coordinate matching; series selection does not establish episode equivalence.

Keep the user's preferred catalogue distinct from the catalogue currently usable. If a provider deletes the preferred series while Plex still reports it, use its saved catalogue until the existing 60-day age limit, then use a remaining usable Plex candidate without erasing the preference. Resume the preferred catalogue if it recovers. A successful Plex inventory observation removing any candidate clears that provider's override; additions and reordering preserve it. This preserves the user's choice through provider-side deletion while letting Plex control candidate membership.

The [specification](../specs/multiple-provider-ids.md) records the product-owner timeline, removal semantics, report behavior, shared scan/recheck integration, and acceptance criteria. This narrowly revisits ADR-0002's proposed exclusion of a primary-catalogue UI for multiple Plex-reported IDs; it does not add arbitrary show mappings or change the ADR-0001 episode-coverage rules. Implementation is separate from this design documentation.
