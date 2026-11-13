---
status: proposed
---

# Optional manual show mappings for matching eligibility

This optional extension is outside the core standalone episode-linking workflow. Direct cross-show episode links require neither this setup nor a primary catalogue selection UI; the user's immediate requirement is to check explicitly linked episode identities when resolving a missing episode.

Providers may split a show's content across different sets of series records, such as TVDB Pokemon (76703) associated with TMDB 60572 and 220150. Instance-local manual show mappings will declare the complete set of eligible provider show identities for episode matching, with multiple show records permitted on either provider side and each provider show belonging to at most one manual mapping. Explicit membership replaces automatic show associations for its members so users can correct erroneous associations as well as supply missing ones.

Show mappings control matching eligibility without adding the linked shows' episode catalogues to a comparison. Each Plex show retains a separate comparison and its own selected primary provider catalogues; Plex inventory records are not merged. The additional identities can support episode crosswalks but do not establish episode equivalence or ownership.

Show mappings are distinct from the episode coverage mappings in ADR-0001. The Pokemon association must not require scanning every related catalogue or displaying a combined franchise comparison when the user only wants additional identities considered during existing episode matching.

Show mappings are optional and are not prerequisites for direct episode coverage. Users may link episode identities across unrelated parent shows without configuring this association or choosing primary catalogues. Deleting a show mapping does not delete independent episode coverage mappings.
