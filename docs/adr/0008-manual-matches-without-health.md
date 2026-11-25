---
status: accepted
supersedes: the Manual Match health parts of ADR-0001 and ADR-0007, and ADR-0001's coverage of TMDB episodes from owned TVDB members
---

# Manual Matches have no health

ADR-0001 gave each Manual Match a health, rechecked on every Plex scan: each member's episode was requested from its provider, and only a **Healthy** match could grant coverage. **Pending** (a member could not be checked) and **Needs review** (TVDB answered that a member's episode is gone) matches granted nothing, and ADR-0007 kept that gate when it moved the Manual Match ahead of automatic matching. In practice the recheck cost every scan about 55 s before its first comparison (272 TVDB and 125 TMDB episode requests, held to TVDB's 200 ms spacing), and it did harm: a provider outage made Pending matches stop covering, so owned episodes showed as missing. The user decides which episodes are equivalent; a provider's opinion of a member adds nothing he uses.

So a Manual Match has no health. A scan makes no request for any Manual Match member, every saved Manual Match is eligible to grant coverage, and member-verification Coverage Issues no longer exist. Apart from its direction (see One-way coverage below), everything else about granting coverage is unchanged: the complete-set rule, direct ownership, ignored-show evidence, no transitive coverage, Report Missing precedence (ADR-0007) and the derived Incomplete combined episode. Saving or editing a Manual Match still resolves every episode at its provider and reviews the preview, so a match still starts from real provider records.

## Consequences

- The Manual Matches report and the Matching Episodes editor show no Healthy, Pending or Needs review status and offer no health filter; selection, paging and delete work over every saved Manual Match.
- A member whose episode a provider has deleted keeps its match covering until a scan removes it (see End-of-scan member removal below) or the match is edited.
- Upgrading (migration 8) drops each saved match's health and health message and every stored member-verification Coverage Issue, with only the links to them, and rejects the Plex Resume point, whose shows were compared while Pending and Needs review matches covered nothing. Saved catalogues and the saved report are kept: the next Plex scan is an ordinary scan, which compares every show again, and nothing is compared again until then.

## Considered options

- **Answer the health recheck from saved catalogues** (rejected in ADR-0007 because a saved catalogue only proves an episode existed when it was downloaded). With no health there is nothing to answer, so that option is moot.
- **Keep health but let Pending matches cover.** It removes the outage harm but keeps the per-scan requests, and Needs review still depends on a check the user does not need.

## One-way coverage

TMDB is the library's official order. Shelfcheck lists a TMDB episode as collected only when Plex owns it by its own season and episode numbers or its own TMDB identity, so a Manual Match covers one way: it grants coverage only to its TVDB members, when every TMDB member is directly owned. Owning TVDB members never gives a TMDB episode Manual Match coverage, however complete the TVDB side. This reverses ADR-0001, where both directly owned TVDB parts covered an otherwise-missing TMDB special. Direct and automatic TMDB matching, including combined/split matching from TMDB records, are unchanged. Scans and cached rechecks share the one rule.

Because a TMDB episode is never covered, it is never left out of combined/split matching by its Manual Match: a TMDB combined episode in a Manual Match stays the combined side of a relationship. A TMDB member is also never credited to its Manual Match in coverage outcomes or missing results; its outcome comes from its numbers, its identity or the missing list.

### Considered options

- **Keep both directions.** A Manual Match whose TVDB side is owned would keep marking a TMDB episode collected that Plex does not hold under the official order, so the TMDB view of the library would overstate what is there.

## End-of-scan member removal

What health used to flag is now cleaned up instead: a Plex scan removes a gone member, one whose own provider show's catalogue, downloaded fresh and complete in that scan, no longer lists its episode. Only the raw list of every episode ID the provider returned counts, specials, unnumbered and unaired records included, and only for the member's own show ID: a reused or saved catalogue, a fallback catalogue of another ID, a failed or incomplete download, or one with an unreadable record proves nothing gone. A reused catalogue is excluded because it may predate the match; a member saved today must never be deleted by yesterday's list. Only a show whose comparison completed with a fresh result proposes removals: a show compared with a saved copy for either provider keeps its last-good saved comparison, so it proposes none, even from the other provider's fresh download.

Each provider's list must hold every episode a member could have been saved from. Saving a TMDB member resolves it by its show, season and episode numbers, and a TMDB download requests every season the show record lists, so its list is complete. Saving a TVDB member resolves its episode record by ID, and that record exists whatever order TVDB arranges the series in, but a TVDB download lists only the series' default season order (`/series/{id}/episodes/default`), and episodes need not exist in every order: a DVD or absolute default can leave out an episode, such as a special, the series still has. So a TVDB download proves an episode gone only when its series record names Aired Order (season type 1, "official"), TVDB's primary order, as its default; under any other default order, or none, it proves nothing gone. Listing every season order of every downloaded series instead would multiply the TVDB requests of every download for a rare clean-up. An episode TVDB has taken out of Aired Order but kept in another order is then treated as gone; editing the match restores it.

The removals are applied after the scan saves its report, as one scan-owned Manual Match change, and the scan then runs the cached recheck of the affected shows before it reports completion; the scan keeps the scan run lock throughout, so no user edit interleaves. Removing a member can change another show's result (a TMDB member gone from one show can let the remaining TMDB set cover a TVDB episode in another, and a many-to-many match becoming one-to-many can derive Incomplete), so removing during the comparison would make results depend on worker order. A Manual Match left without a TMDB or TVDB member is deleted (Pinky and the Brain S04E09 matched to Animaniacs S05E24 is deleted when TVDB no longer lists S05E24). The remaining members keep their Report Missing flags; the manual-save rule about flags on both sides is not applied. Each committed removal is written to the Plex scan log; there is no Coverage Issue for it.

Boundaries: a scan that fails, is interrupted or is vetoed before its report is saved removes nothing, and a later scan with its own fresh complete download can. A removal change that fails rolls back whole. A removal committed before a failed cached recheck stays; its members stay carried and the comparison pending until a later recheck or scan. The scan reports completion only after the removals and the recheck are accounted for: a process that ends while applying them leaves the scan running in its Manual Match removal phase, so it is recorded as interrupted there, never as completed. Its report and Resume point were already settled, committed removals stay, and their members stay carried and pending, with the scan-failure Coverage Issue saying so, until a later recheck or scan. Cached rechecks never remove members.

Trade-off: a provider that deletes an episode and re-adds it under a new ID loses that member at the next fresh download, and the re-added episode shows as missing until the user edits the match to add it. We accept that: matching the new record automatically would mean guessing identity from numbering or titles, which is what a Manual Match exists to override.

### Considered options

- **Remove during the comparison, before later shows compare.** Results would depend on worker completion order and could stay wrong for shows already compared.
- **Remove in a batch before any comparison.** It needs every show's fresh catalogue before the first comparison, delaying the scan for a rare clean-up.
- **Prove absence from a still-fresh saved catalogue.** It saves downloads but can delete a member added after that catalogue was downloaded.
