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

**Report Missing**:
A user's local Shelfcheck exception, saved on a member of a Manual Match, stating that the library lacks that episode's content even though ownership or matching would mark it collected. It applies to the provider episode across all Plex libraries, not to a file or Plex item, and lasts until the user clears it or the member leaves its Manual Match. It is never sent to Plex, TMDB, or TVDB. It replaces ownership corrections, which declared the content of individual Plex items and were retired without conversion.
_Avoid_: Ownership correction, declared content

**Reported missing**:
The status of an episode whose Report Missing flag is set. It outranks every collected determination, so the episode and its show stay in Plex missing results. Flagging one member does not flag another member.
_Avoid_: Keep missing, marked missing

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
