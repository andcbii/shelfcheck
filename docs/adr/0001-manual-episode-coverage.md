---
status: accepted
---

# Use standalone episode coverage mappings as a missing-episode fallback

Providers may describe the same content as one combined episode or several split episodes. Instance-local manual coverage mappings will relate a complete set of TMDB episode records to a complete set of TVDB episode records, initially for Plex scans only. For this manual check, owning every episode in either set grants coverage for the other set; an incomplete set grants no additional coverage, because treating individual members as interchangeable would incorrectly let one part satisfy the entire combined episode.

Every existing matching check runs first, including direct ownership, shared IMDb identity, Trakt crosswalks, TMDB external-ID crosswalks, and enabled compound-episode matching. Only if an episode would still be missing does Shelfcheck check its manual coverage mapping against directly owned episode identities across the Plex inventory, regardless of parent-show associations. This is the final matching step before adding an episode to missing results. The manual check adds coverage while preserving existing automatic ownership decisions (reopened by #30; see below); the complete-set requirement governs coverage added by the mapping, not results already satisfied by normal matching.

For the Blaze Christmas special, the relationship is TMDB episode `6741845` to the complete set of TVDB episodes `11551379` and `11551380`. A directly owned complete TMDB special can cover either otherwise-missing TVDB part; both directly owned TVDB parts can cover the otherwise-missing TMDB special. Owning only one TVDB part adds no coverage for the other part or the complete special.

Each provider episode belongs to at most one coverage mapping; selecting a member of an existing mapping opens that mapping for editing. Mappings may cross season and provider show boundaries after every record resolves and its show, title, and numbering are presented for review. Restricting these links to matching coordinates or parent series would preserve the provider disagreements this feature is intended to correct.

Episode coverage mappings are standalone: they require no show mapping or primary catalogue configuration. An explicit episode link may cross otherwise unassociated shows. Deleting a related show mapping retains independently saved episode mappings; bulk deletion removes exactly the selected mappings without cascading to those independent records.

~~When evaluating manual coverage, Plex items carrying conflicting combined and split episode identities require an explicit ownership correction before granting additional coverage through the mapping.~~ Superseded by #30: a Plex item's direct identities are used as reported. An item that carries the combined episode's identity covers every mapped part even when it also carries a split identity. Report Missing, saved on mapping members, replaces ownership corrections as the way to record that a local file lacks content.

Direct ownership used by the manual check aggregates across all Plex TV libraries included in a scan, including items from ignored shows. Ignore continues to suppress a show's own missing results and provider comparison; it does not prevent that show's owned content from satisfying mapped content elsewhere. Inferred coverage from either automatic crosswalks or manual mappings does not become direct ownership that can satisfy a mapping's prerequisites.

Mappings persist independently of inventory, scan reports, and caches, including when neither side is currently owned. Saving, editing, or deleting a Manual Match, including bulk deletion, immediately rechecks only affected shows using cached data and marks those shows for fresh provider downloads on the next user-run library scan. Both the old and new members of an edited match must be rechecked so previously granted coverage can be withdrawn; cross-show matches may affect more than one show. These changes preserve unrelated results and caches and do not start or queue a full library scan. Every user-run library scan still checks the full Plex library for changes. This replaces the earlier decision to defer all mapping-related comparisons until the next library scan. ADR-0003 defines the shared backend, provider refresh obligations, and scan-time mutation protection used by every matching surface.

A confirmed deleted provider record leaves its mapping available for repair as **Needs review** and prevents additional coverage until repaired. Temporary provider outages retain the mapping with pending results. The manager must support bulk deletion of broken mappings as well as individual repair and deletion.

An incomplete mapping with remaining missing episodes appears as one grouped result showing directly owned members, missing members, and alternative complete sets, with each provider's own identities and numbering preserved. Members already satisfied by normal matching keep that status; their inferred coverage does not complete a source set for the manual check. Show records and episode records must be distinguished during input resolution so a whole-show identity is not mistaken for an episode identity.

## Reopened by #30: ownership corrections retired

Spec #30 deliberately reopens two parts of this decision.

- **Correction prerequisite.** Ownership corrections, their per-file fingerprints, selected-parts declarations, and the conflict gate that suppressed manual coverage for mixed combined/split items are removed. The complete-set Manual Match alone is sufficient: owning the complete combined episode covers every mapped part in either provider direction, owning every mapped part covers the combined episode, and owning only some parts grants no additional coverage through the mapping. Saved corrections are discarded on upgrade without conversion into any other decision; existing Manual Matches are retained unchanged. The correction mutation is no longer accepted.
- **Preservation of earlier automatic collected decisions.** Report Missing, a per-member local exception saved with the Manual Match, overrides direct ownership and every automatic and manual matching method, including decisions made before the manual check. Its controls, propagation, and lifecycle are delivered by the tickets following #36.

### Report Missing for one-to-one Manual Matches (#37)

- A flag is saved state on the mapping's membership row, keyed by provider episode, so it applies across all Plex libraries and is deleted with the member or mapping. Members that existed before the flag default to off.
- The shared comparison checks a flag before coordinates, direct ownership, crosswalks, compound matching, and Manual Match coverage, and grouped results label it **Reported missing** ahead of direct ownership. A flag changes only its own episode: the flagged member's owned identities still count as source evidence for the other member, and the opposite member is never flagged automatically.
- A save may change only the flags of an existing mapping without re-resolving its members. It uses the same revision check, scan lock, immediate cached recheck, and next-scan refresh obligations as any other Manual Match save. A flag-only save keeps the mapping's saved health because no provider record was re-reviewed.
- Editing members without restating flags keeps flags on retained members and drops flags on removed members. Flags on larger mappings are rejected until their rules are delivered; larger mappings keep working without flags.

### Report Missing for combined and split episodes (#38)

- Flags are accepted whenever one provider side of the Manual Match has a single episode, in either provider direction. Many-to-many mappings still reject flags until their rules are delivered.
- When the single episode is a combined episode mapped to two or more split episodes, any reported-missing split episode makes the combined episode an **incomplete combined episode**, labeled **Incomplete · mapped part missing**, with an explanation naming the flagged part or parts responsible. The status is recalculated from the currently saved flags by the shared comparison and by grouped results; it is never stored as a flag, so clearing a part's flag, removing that member, or deleting the mapping withdraws only that part's effect while other flagged parts keep the combined episode incomplete.
- The derived status has the same precedence as Reported missing: it is checked before coordinates, direct ownership, crosswalks, compound matching, and Manual Match coverage, and grouped results label it ahead of direct ownership, so it cannot be hidden by any of them. An explicit flag on the combined episode outranks the derived label and is independent of its parts' flags.
- Neither status removes source evidence. The combined episode's directly owned identities still cover every unflagged part through the complete Manual Match, so explicitly flagging only the combined episode makes no part missing, and flagging one part leaves the others collected.
- One-to-one Manual Matches keep the #37 rule that a flag changes only its own episode; with one episode on each side there is no combined episode to make incomplete.

### Report Missing for many-to-many Manual Matches (#39)

- Many-to-many Manual Matches now accept flags. Because neither side is a single combined episode, Shelfcheck cannot know which opposite-side episode contains a flagged one, so it derives no status: each flag affects only its own episode with the #37 precedence, scope, and durability, and unselected episodes keep their normal matching evidence.
- Every manual save, whether flag-only or a reviewed membership edit, applies the **both-sides-or-none rule**: when the saved shape is many-to-many, the explicit flags must be empty or include at least one episode on each provider side. Derived status never satisfies it. The editor checks the draft before sending it and explains how to repair the selection or clear every flag; the mapping mutation rejects a one-sided save with `report-missing-one-sided` before writing anything, so the saved mapping, its flags, and cached results are unchanged.
- The rule belongs to manual saves only. Reading, listing, comparing, rechecking, and deleting accept a one-sided persisted state, which automatic Ignore cleanup may leave; its remaining flags stay active until the next manual save repairs or clears them.

The shared backend, immediate cached recheck, next-scan refresh obligations, and active-scan mutation protection of ADR-0003 are unchanged.

## Manual Matches and Matching Episodes

Manual Matches are controlled by the user; Auto Matches are controlled by Shelfcheck. Remove the **Manual Coverage** entry from the top banner. Reports provide **01 — Manual Matches**, **02 — Auto Matches**, **03 — Unmatched Shows**, **04 — Provider Matches**, and **05 — Coverage Issues**.

The Manual Matches report remains visible with zero records and provides **Add Manual Match** even when empty. It lists every saved match, including matches whose episodes are fully collected or whose content is not owned. Each complete match is one row and one counted record, with all of its episodes shown together. Follow Auto Matches' visual style, episode details, provider links, row separators, and pagination, using provider panels like Provider Matches to accommodate multiple episodes on either side. For example, one row links TMDB Animaniacs S03E18 to both TVDB episode 9623383 and episode 9623973; it is not two separate matches. Retain selection, editing, individual and bulk deletion, health filtering, **Healthy / Pending / Needs review** status, and expandable coverage evidence.

Selecting an episode on the Plex results page offers **Matching Episodes**, with a pointer cursor on clickable controls. This opens an in-place dialog titled **Matching Episodes**, rather than navigating to Reports. For an unmatched episode, prefill that episode in the setup form and omit the saved-match section. For an episode already in a Manual Match, load every member of that complete match for editing and show only that match's details and evidence below the form, even when neither side is owned. Never show unrelated matches or matches for other episodes merely because they belong to the same show.

Saving keeps the dialog open and displays the saved match. Close and clicking outside the dialog behave identically: dismiss the dialog, discard unsaved changes without implicitly saving, and preserve the Plex results and scroll position. The targeted recheck described above updates affected results after a save.

## Coverage Issues

The pending-coverage warning links to **05 — Coverage Issues**, a separate report that remains available with an empty state when there are no issues. Show the warning only while issues exist. The report explains every cause behind the warning, identifying affected shows and episodes where known, the failed operation or provider, and a readable reason. Include unverified provider catalogue freshness and failed provider refreshes even for shows without Manual Matches. Failures that cannot be attributed to a particular show, such as library-wide failures, appear separately. A global pending flag or generic connection advice alone is insufficient to explain which content could not be checked. The warning and report consume the same structured current issue state supplied by the shared backend; resolving a cause must remove the corresponding issue rather than leave stale warnings.

Issue #14 owns the shared backend described by ADR-0003. Issue #15 depends on #14 and owns the Manual Matches and Coverage Issues reports, report navigation, Matching Episodes dialog, and integration with those backend operations. Reports and dialogs must not implement independent comparison engines, cache policies, refresh queues, or diagnostic stores. Their mutation controls must respect the shared active-scan lock, including a dialog opened before a scan begins.
