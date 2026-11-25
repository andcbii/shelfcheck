# Shelfcheck

Shelfcheck identifies aired TV episodes missing from a Trakt collection or Plex library.

## Language

**Provider catalogue**:
A provider's description of a show and its episodes, including their identities, numbering, and air dates. TMDB and TVDB may describe the same content differently.

**Library inventory**:
The shows and episode items present in the Plex libraries included in a scan, together with the identities Plex assigns to them.

**Comparison catalogue**:
The provider catalogue selected as the reference for checking one library show's missing episodes. TMDB and TVDB have independent comparison catalogues.

**Catalogue override**:
A user's preferred comparison catalogue, chosen from the series identities Plex reports for that provider. The preference can remain saved while an unavailable catalogue requires another catalogue to be used.

**Fallback catalogue**:
A comparison catalogue used while the preferred catalogue is unavailable and has no usable saved copy. Using a fallback does not replace the user's saved catalogue override.

**Scan run**:
One Trakt or Plex scan, from its start until it completes, fails, or is interrupted. A scan run checks either the whole collection or library, or a single show. Only one scan run, Trakt or Plex, is active at a time.
_Avoid_: Job, sync

**Interrupted scan**:
A scan run that stopped without completing or failing, such as through a server restart, recognised once it has gone a set time without reporting progress.

**Resume point**:
The progress a full scan run saves part-way through, so the next scan run of the same kind can continue from it instead of starting over. It stops being usable once it is too old or was saved under different scan settings. Single-show scan runs never save one.
_Avoid_: Checkpoint (in conversation; the code uses it)

**Provider cooldown**:
A time before which a provider has asked Shelfcheck not to contact it again, because of rate limiting or an outage. A cooldown longer than 15 minutes makes that provider unavailable for the scan run: a Trakt scan run fails and can resume afterwards, and a Plex scan run continues with its other providers where it can. A later scan run honours whatever remains of the cooldown until Shelfcheck restarts.
_Avoid_: Rate-limit pause (a short wait within a scan run)

**Completed full scan**:
A scan that obtains the complete library inventory and finishes processing the library, even when individual checks leave unresolved issues. Interrupted scans and scans with incomplete library inventory do not qualify.

**Provider verification position**:
The point through which a provider's catalogue changes have been checked, with identified changes either handled or retained for follow-up. TMDB and TVDB have independent verification positions.

**TMDB verification recovery**:
Refreshing the TMDB catalogues whose freshness TMDB's change feed cannot vouch for, because TMDB's provider verification position is missing or older than the feed can cover. A catalogue is current as of its own successful download.
_Avoid_: Blanket refresh, baseline recovery

**Refresh obligation**:
A show's durable, per-provider requirement to download catalogues instead of reusing saved copies. It holds three kinds of requirement that coexist: the preferred catalogue (raised by a failed preferred catalogue, a Manual Match change or a catalogue override change); a specific catalogue ID (raised by the fifth-scan safeguard for the catalogue it compared, which may be a fallback); and every catalogue the scan tries (raised by a single-show Clear cache). Each is satisfied only by a complete successful download: the preferred and every-attempted requirements by the preferred catalogue's, a specific requirement by the named catalogue's. For a provider with one catalogue, that catalogue is the preferred one. Reuse, title-only repair, incomplete or failed downloads and cached rechecks satisfy nothing.
_Avoid_: Refresh flag, pending refresh

**Cached recheck**:
A comparison of affected shows run immediately after a Manual Match or catalogue override change, or after an Ignore that clears Report Missing flags, using only saved catalogues, saved library inventory and saved evidence. After a Manual Match change or such an Ignore, it also compares the shows of every carried member. It downloads nothing, enumerates nothing in Plex, and never satisfies a refresh obligation or renews any catalogue's age.
_Avoid_: Offline recheck, local recheck

**Carried member**:
An episode of a saved Manual Match change, in one show, whose show has not yet been compared since the change. Carried members outlast failed rechecks and restarts, and keep the comparison pending. A member stops being carried only when a cached recheck or a completed full scan compares its shows; a failed comparison of its show keeps it carried.
_Avoid_: Pending member, dirty member

**Fifth-scan safeguard**:
On a UTC day's fifth, tenth, and every later fifth completed full scan, the refresh of TMDB catalogues for library shows in that day's TMDB change list, bypassing same-day reuse. It never forces TVDB refreshes.
_Avoid_: Periodic refresh, fifth-scan refresh

**Pending safeguard**:
A fifth-scan safeguard whose required TMDB change list could not be retrieved. It keeps its original UTC day's interval across later scans, restarts, and UTC midnight until it is fulfilled or covered by TMDB verification recovery.
_Avoid_: Missed safeguard, overdue refresh

**Manual Match**:
A match explicitly set and controlled by the user, including matches created through Manual Coverage or Link Episodes. Every saved Manual Match can grant coverage, one way: it covers its TVDB episodes when every TMDB episode in it is directly owned, and never covers a TMDB episode. It has no health or verification status.
_Avoid_: Manual Coverage, Link Episodes, mapping (as names for the saved match)

**Official order**:
The provider whose episode list is the library's own: TMDB. A TMDB episode is collected only by its own season and episode numbers or its own identity, never through a Manual Match.

**Gone member**:
A Manual Match member whose episode its own provider show no longer lists, in that show's catalogue downloaded fresh and complete in a scan run whose comparison of the show completed with a fresh result, and whose provider then confirms the episode gone: a 404, a TVDB episode now in another series, or a TMDB episode number that now names another episode. A reused, saved, failed, incomplete, truncated or fallback catalogue never makes a member a candidate, and a member the provider still has, or that cannot be looked up, is kept. Once the scan has saved its report, it removes its gone members from their Manual Matches, deleting a Manual Match left without a TMDB or TVDB member.
_Avoid_: Stale member, broken member, Needs review

**Auto Match**:
A match determined and controlled by Shelfcheck through automatic matching.

**Coverage Issue**:
An unresolved condition that prevents Shelfcheck from verifying episode coverage or provider catalogue freshness. It may affect a show, an episode, or an entire library, whether or not a Manual Match exists. The Scan Issues report lists them.

**Provider Lookup Failure**:
A Coverage Issue recording that a show or episode could not be looked up at a provider, for any reason: a missing ID, "not found", an outage, a rate limit, a failed sign-in or an unreadable answer.

**Gone provider record**:
A provider series ID whose series request has answered "not found" on 15 separate UTC days since its last complete catalogue download, and whose saved catalogue is more than 60 days old. Its saved catalogue is kept but never compared, and one complete download makes it usable again. Outages, other failures, and "not found" answers for its seasons or episodes never count toward it. An ID never downloaded has no catalogue age and is never gone.
_Avoid_: Deleted show, dead ID

**Total Provider Lookup Failure**:
A provider that cannot describe a show from a current lookup: every series ID tried for it has a Provider Lookup Failure, or it has no ID at all, from Plex or through the other provider. IDs never tried don't count as failing. The show may still compare that provider's last saved catalogue until the record is a Gone provider record.

**Unmatched show**:
A library show with no usable catalogue from any provider, live or saved. The Unmatched Shows report lists them.
_Avoid_: Unmatched (for a show that still has results)

**Partially matched show**:
A show that is not unmatched but has a Total Provider Lookup Failure for at least one provider, including one that is falling back to a saved catalogue. It is compared with whatever catalogues remain usable.
_Avoid_: Partial Match (Manual Match and Auto Match are episode matches)

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
A relationship between two complete sets of episode records that represent the same content. Each set is an alternative complete representation of that content. Directly owning every record in the TMDB set covers every record in the TVDB set, even when a Plex item also carries an identity from the TVDB set; owning only part of the set adds no coverage. Owning the TVDB set never covers a TMDB record, since TMDB is the official order.

**Show mapping**:
An association between provider show records that identifies related catalogues for episode matching. It can relate multiple records on either provider side without declaring individual episodes equivalent.

**Episode crosswalk**:
A lookup that relates a TVDB episode to another identity for the same episode (its IMDb ID, Trakt's episode search, or TMDB's external-ID search) so that ownership can be matched when provider numbering differs. It is automatic matching evidence and never creates a Manual Match.

**Provider relationship**:
Evidence from a provider lookup about show or episode identities, such as a series association, series summary or episode crosswalk. Shelfcheck can save it for a comparison or share a crosswalk outcome across comparisons. It does not by itself establish library ownership or create a Manual Match.
_Avoid_: Provider cache, lookup result

**Evidence source**:
Where one show comparison gets its provider relationships: live evidence in a scan run, or saved evidence in a cached recheck. A comparison uses exactly one.

**Live evidence**:
The provider relationships a scan run's comparison obtains, either reusing a saved answer the freshness rules still allow or asking the provider again. Each answer received is saved for later cached rechecks.
_Avoid_: Live mode

**Saved evidence**:
The provider relationships a cached recheck compares from: the comparison's saved copies, newer shared crosswalk evidence, and what its saved catalogues already say about the show. It never asks a provider; a missing saved answer leaves that episode or show unresolved instead.
_Avoid_: Replay mode, offline evidence

**Episode crosswalk freshness**:
The rule that a saved TMDB external-ID crosswalk response, whether a match or a valid empty answer, is reused only on the UTC date it was actually received. A live scan that reaches that matching step requests it again when the response is missing, undated, or received before the scan's starting UTC date. Reuse, cached rechecks and restarts never renew the receipt time, and the rule is independent of TMDB's show change feed and of provider catalogue freshness.
_Avoid_: Crosswalk expiry job, daily cache clear

**Rejected crosswalk response**:
A saved TMDB external-ID crosswalk response whose required refresh in a live scan failed, by a failed request or an unreadable successful response. It grants no coverage in that scan, in later cached rechecks or after a restart, even when the show's last-good comparison is otherwise retained, and the lookup is retried on the next live scan that needs it. Only a later usable response replaces it; coverage from another method does not mark it recovered.
_Avoid_: Stale fallback, expired match

**Shared crosswalk evidence**:
The latest outcome of one TVDB episode's TMDB external-ID crosswalk, shared by every show comparison that needs that lookup: a usable response with its receipt time, or a rejection. It is a provider relationship, not an ownership decision; each comparison still decides coverage against current library inventory. A later outcome in one comparison, a replacement or a rejection, applies to every other comparison and cached recheck that saved the older answer. A usable response received after a comparison's own request for the lookup failed also reaches that comparison's cached recheck, which has no saved copy; the recheck saves it as that comparison's own copy and then resolves that failed request. Clearing one show's cache marks as not current only the TMDB external-ID crosswalks that show saved for its TVDB episodes; a series association never marks an episode with the same numeric ID. The show's other provider relationships are still cleared with its cache. Clearing never lets a cached recheck revive an older copy: a usable response is only marked not current for live scans, and a rejection is kept.
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

**Show year**:
The year shown with a show's name on Plex pages and Manual Matches: the year Plex gives the show in the latest completed full scan, kept until a later scan gives one. A provider show that no Plex show holds, or that Plex shows with different years hold, takes its provider's own year. The Trakt page and provider-candidate lists show their source's own year instead. Clear cache keeps both saved Plex years and provider years.
_Avoid_: Release year, premiere year

**Air date**:
The date a provider lists for an episode's first broadcast, whether past or future. Also called the premiere date; TMDB shows it as "Air Date" and TVDB as "First Aired". An episode may have none.
_Avoid_: Release date, aired date

**Aired**:
The state of an episode whose air date is today or earlier in the user's local calendar. An episode with no air date, or an air date in the future, is **unaired**. The air-date delay never changes whether an episode has aired.
_Avoid_: Released, available

**Air-date delay**:
A number of calendar days by which an episode's air date is treated as later when deciding whether to show it as missing. It affects only missing results, never whether the episode has aired.
_Avoid_: Airing grace period, aired-date offset, airing offset

**Settings**:
The choices that control how Shelfcheck runs, made in the gear menu (such as diagnostics, the air-date delay and hiding unaired episodes), and the connections to the Trakt, Plex and provider APIs.
_Avoid_: Preferences (for these choices)

**Preferences**:
The user's own decisions about particular shows and episodes: Ignores, Manual Matches and other user-chosen matching, such as catalogue overrides.
_Avoid_: Settings (for these decisions)

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

**Active ignore**:
An ignore with no expiry, or with an expiry strictly later than the evaluation time. An ignore whose expiry equals the evaluation time has ended.
_Avoid_: Live ignore, current ignore

**Season ignore**:
An ignore covering a group of selected seasons of one show, all sharing one duration, rather than the entire show. It is independent of any whole-show ignore.

**Restore**:
Ending an ignore before its expiry, or ending a permanent ignore.
_Avoid_: Recover, undelete
