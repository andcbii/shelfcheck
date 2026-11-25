---
status: accepted
supersedes: the Manual Match health parts of ADR-0001 and ADR-0007
---

# Manual Matches have no health

ADR-0001 gave each Manual Match a health, rechecked on every Plex scan: each member's episode was requested from its provider, and only a **Healthy** match could grant coverage. **Pending** (a member could not be checked) and **Needs review** (TVDB answered that a member's episode is gone) matches granted nothing, and ADR-0007 kept that gate when it moved the Manual Match ahead of automatic matching. In practice the recheck cost every scan about 55 s before its first comparison (272 TVDB and 125 TMDB episode requests, held to TVDB's 200 ms spacing), and it did harm: a provider outage made Pending matches stop covering, so owned episodes showed as missing. The user decides which episodes are equivalent; a provider's opinion of a member adds nothing he uses.

So a Manual Match has no health. A scan makes no request for any Manual Match member, every saved Manual Match is eligible to grant coverage, and member-verification Coverage Issues no longer exist. Everything else about granting coverage is unchanged: the complete-set rule, direct ownership, ignored-show evidence, no transitive coverage, Report Missing precedence (ADR-0007) and the derived Incomplete combined episode. Saving or editing a Manual Match still resolves every episode at its provider and reviews the preview, so a match still starts from real provider records.

## Consequences

- The Manual Matches report and the Matching Episodes editor show no Healthy, Pending or Needs review status and offer no health filter; selection, paging and delete work over every saved Manual Match.
- A member whose episode a provider has deleted keeps its match covering until the match is edited.
- Upgrading (migration 8) drops each saved match's health and health message and every stored member-verification Coverage Issue, with only the links to them, and rejects the Plex Resume point, whose shows were compared while Pending and Needs review matches covered nothing. Saved catalogues and the saved report are kept: the next Plex scan is an ordinary scan, which compares every show again, and nothing is compared again until then.

## Considered options

- **Answer the health recheck from saved catalogues** (rejected in ADR-0007 because a saved catalogue only proves an episode existed when it was downloaded). With no health there is nothing to answer, so that option is moot.
- **Keep health but let Pending matches cover.** It removes the outage harm but keeps the per-scan requests, and Needs review still depends on a check the user does not need.
