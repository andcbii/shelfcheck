# Shelfcheck

Shelfcheck identifies aired TV episodes missing from a Trakt collection or Plex library.

## Language

**Provider catalogue**:
A provider's description of a show and its episodes, including their identities, numbering, and air dates. TMDB and TVDB may describe the same content differently.

**Library inventory**:
The shows and episode items present in the Plex libraries included in a scan, together with the identities Plex assigns to them.

**Completed full scan**:
A scan that obtains the complete library inventory and finishes processing the library, even when individual checks leave unresolved issues. Interrupted scans and scans with incomplete library inventory do not qualify.

**Provider verification position**:
The point through which a provider's catalogue changes have been checked, with identified changes either handled or retained for follow-up. TMDB and TVDB have independent verification positions.

**TMDB verification recovery**:
Refreshing the TMDB catalogues whose freshness TMDB's change feed cannot vouch for, because TMDB's provider verification position is missing or older than the feed can cover. A catalogue is current as of its own successful download.
_Avoid_: Blanket refresh, baseline recovery

**Refresh obligation**:
A show's durable requirement to download a fresh catalogue from one provider on the next full scan, satisfied only by a successful download from that provider. Manual Match changes, cache clearing, and the fifth-scan safeguard create one.
_Avoid_: Refresh flag, pending refresh

**Fifth-scan safeguard**:
On a UTC day's fifth, tenth, and every later fifth completed full scan, the refresh of TMDB catalogues for library shows in that day's TMDB change list, bypassing same-day reuse. It never forces TVDB refreshes.
_Avoid_: Periodic refresh, fifth-scan refresh

**Pending safeguard**:
A fifth-scan safeguard whose required TMDB change list could not be retrieved. It keeps its original UTC day's interval across later scans, restarts, and UTC midnight until it is fulfilled or covered by TMDB verification recovery.
_Avoid_: Missed safeguard, overdue refresh

**Manual Match**:
A match explicitly set and controlled by the user, including matches created through Manual Coverage or Link Episodes.
_Avoid_: Manual Coverage, Link Episodes (as names for the saved match)

**Auto Match**:
A match determined and controlled by Shelfcheck through automatic matching.

**Coverage Issue**:
An unresolved condition that prevents Shelfcheck from verifying episode coverage or provider catalogue freshness. It may affect a show, an episode, or an entire library, whether or not a Manual Match exists.

**Episode-scoped failure**:
An unresolved episode lookup or coverage check whose impact is limited to the affected episode and relationships that depend on it. Independent episode checks remain usable, including other ways to establish coverage for that episode.

**Shared-input failure**:
An unavailable or unusable prerequisite that prevents reliable comparison of an entire show or library, rather than an individual episode or dependent relationship.

**Episode coverage**:
The content represented by an episode record, which may correspond to one or several records at another provider. A complete combined episode covers each of its parts; an individual part covers only that part.

**Combined episode**:
An episode record containing content that another provider lists as multiple episodes.

**Split episode**:
One of the parts of a combined episode, listed as a separate episode by a provider.

**Coverage mapping**:
A relationship between two complete sets of episode records that represent the same content. Each set is an alternative complete representation of that content. Directly owning every record in one set covers every record in the other, even when a Plex item also carries an identity from the other set; owning only part of a set adds no coverage.

**Show mapping**:
An association between provider show records that identifies related catalogues for episode matching. It can relate multiple records on either provider side without declaring individual episodes equivalent.

**Episode crosswalk**:
A lookup that relates a TVDB episode to another identity for the same episode (its IMDb ID, Trakt's episode search, or TMDB's external-ID search) so that ownership can be matched when provider numbering differs. It is automatic matching evidence and never creates a Manual Match.

**Episode crosswalk freshness**:
The rule that a saved TMDB external-ID crosswalk response, whether a match or a valid empty answer, is reused only on the UTC date it was actually received. A live scan that reaches that matching step requests it again when the response is missing, undated, or received before the scan's starting UTC date. Reuse, offline rechecks and restarts never renew the receipt time, and the rule is independent of TMDB's show change feed and of provider catalogue freshness.
_Avoid_: Crosswalk expiry job, daily cache clear

**Rejected crosswalk response**:
A saved TMDB external-ID crosswalk response whose required refresh in a live scan failed, by a failed request or an unreadable successful response. It grants no coverage in that scan, in later offline rechecks or after a restart, even when the show's last-good comparison is otherwise retained, and the lookup is retried on the next live scan that needs it. Only a later usable response replaces it; coverage from another method does not mark it recovered.
_Avoid_: Stale fallback, expired match

**Shared crosswalk evidence**:
The latest outcome of one TVDB episode's TMDB external-ID crosswalk, shared by every show comparison that needs that lookup: a usable response with its receipt time, or a rejection. It is a provider relationship, not an ownership decision; each comparison still decides coverage against current library inventory. A later outcome in one comparison, a replacement or a rejection, applies to every other comparison and offline recheck that saved the older answer, and clearing one show's cache never lets an offline recheck revive an older copy: a usable response is only marked not current for live scans, and a rejection is kept.
_Avoid_: Crosswalk cache, shared match

**Report Missing**:
A user's local Shelfcheck exception, saved on a member of a Manual Match, stating that the library lacks that episode's content even though ownership or matching would mark it collected. It applies to the provider episode across all Plex libraries, not to a file or Plex item, and lasts until the user clears it or the member leaves its Manual Match. It is never sent to Plex, TMDB, or TVDB. It replaces ownership corrections, which declared the content of individual Plex items and were retired without conversion.
_Avoid_: Ownership correction, declared content

**Reported missing**:
The status of an episode whose Report Missing flag is set. It outranks every collected determination, so the episode and its show stay in Plex missing results. Flagging one member does not flag another member.
_Avoid_: Keep missing, marked missing

**Incomplete combined episode**:
The derived status, shown as **Incomplete · mapped part missing**, of a combined episode whose Manual Match maps it alone to several split episodes when one or more of those split episodes is reported missing. It is recalculated from the currently saved Report Missing flags and is never saved as a flag itself, so it ends as soon as the last responsible flag is cleared or its member leaves the Manual Match. It has the same precedence as Reported missing, which it yields to when the combined episode is also flagged. Reporting the combined episode missing never makes its split episodes missing.
_Avoid_: Derived flag, inferred missing

**Many-to-many Manual Match**:
A Manual Match whose TMDB and TVDB sides each list two or more episodes, so neither side is a single combined episode. Shelfcheck never guesses which opposite-side episode contains a reported-missing episode, so no status is derived: each Report Missing flag affects only its own episode. A manual save must leave either no flags or at least one explicit flag on each provider side (the **both-sides-or-none rule**); derived status never satisfies it. The rule checks manual saves, including membership edits that change the mapping into this shape, and never rejects reading or comparing saved flags, so a one-sided state left by automatic cleanup stays active until the next manual save repairs or clears it.
_Avoid_: Partial selection, guessed correspondence

**Ignore**:
An exclusion of a show or selected seasons from missing-episode results in one search mode, either temporarily or permanently.
_Avoid_: Dismiss, snooze

**Permanent ignore**:
An ignore with no expiry that remains in effect until restored.
_Avoid_: Permanent deletion

**Temporary ignore**:
An ignore that ends automatically at its chosen expiry.
_Avoid_: Temporary deletion, timed dismissal

**Expiry**:
The instant at which a temporary ignore ends.
_Avoid_: Renewal date

**Season ignore**:
An ignore covering a group of selected seasons of one show, all sharing one duration, rather than the entire show. It is independent of any whole-show ignore.

**Restore**:
Ending an ignore before its expiry, or ending a permanent ignore.
_Avoid_: Recover, undelete
