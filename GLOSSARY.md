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
A relationship between two complete sets of episode records that represent the same content. Each set is an alternative complete representation of that content.

**Show mapping**:
An association between provider show records that identifies related catalogues for episode matching. It can relate multiple records on either provider side without declaring individual episodes equivalent.

**Ownership correction**:
A user's declaration of the content actually contained in a Plex item whose provider identities describe conflicting episode coverage.

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
