# Multiple provider IDs and comparison catalogue selection

Status: specified from product-owner Q&A; implementation has not started.

## Problem and outcome

Plex can attach multiple TMDB or TVDB series IDs to a single show. Shelfcheck currently overwrites earlier IDs while reading Plex's GUID list, so the last ID wins. Reordering that list can change the provider catalogue used to identify missing episodes.

Choose comparison catalogues predictably, let users override that choice, and explain the selection in a new Multiple Provider IDs report and a small notice on the results page. Keep the existing episode matching behavior, including matching by season and episode coordinates.

The motivating case is a Plex show reporting TMDB **The Scooby-Doo/Dynomutt Hour (2150)** and **The Scooby-Doo Show (337142)**, alongside TVDB **The Scooby-Doo Show (73817)**. The default TMDB comparison catalogue becomes 2150; the user can choose 337142 instead. TVDB remains 73817. These series describe different episode catalogues even though Plex attaches them to the same show.

## Scope

- Apply the same rules independently to TMDB and TVDB for each Plex show.
- Preserve every distinct provider series ID reported by Plex. Duplicate occurrences and ordering do not change the candidate set.
- Select one comparison catalogue per provider; do not combine the episode catalogues of multiple series.
- A catalogue override is separate from an episode Manual Match. This feature neither creates episode equivalences nor changes existing Manual Matches, Report Missing, automatic crosswalks, compound matching, or coordinate-based ownership.
- Do not change Plex or provider metadata. Do not require the user to repair Plex metadata to use the feature.

## Automatic selection and overrides

1. With no override, select the lowest numeric series ID currently reported by Plex for that provider. Recalculate this automatic choice on each scan. Newly added higher IDs do not change it; a newly added lower ID can change it.
2. Let the user select an override only from that provider's IDs currently reported by Plex. Show provider names and IDs so the user can distinguish catalogues.
3. Save the preference across scans, cached rechecks, and restarts. GUID order changes have no effect.
4. Adding a candidate preserves an existing override, even if the added ID is lower. Updating a candidate's name has no effect on the saved preference.
5. Removing any candidate from that provider's last successfully observed candidate set clears that provider's override on the next scan that observes the removal. Then apply automatic selection to the remaining candidates. This includes removing an unchosen candidate: A+B becoming A clears an A override, while A+B becoming B clears an A override and selects B.
6. A change on the TVDB side does not clear a TMDB override, or vice versa. Missing or failed Plex inventory requests do not establish that an ID was removed; retain known preferences until a successful inventory observation establishes the change.
7. A provider deleting a series does not remove its ID from Plex's candidate set. Only Plex's successfully observed inventory can establish that removal.
8. A user can clear their override explicitly to return to automatic selection.

Shows without multiple IDs continue their existing provider-resolution behavior. An automatic lowest-ID choice can change the selected catalogue on the first scan after implementation; do not silently convert the previous last-ID choice into a user override.

## Provider deletion, saved catalogues, and fallback

Keep the saved preference distinct from the comparison catalogue currently being used.

- When Plex still reports A and B and the user overrides to B, prefer B.
- If the provider confirms that B has been deleted, continue using B's last successfully downloaded catalogue while that saved catalogue remains usable.
- The age limit is **60 elapsed days since B's last successful download**. Reuse, comparison, discovering the deletion, and restarting Shelfcheck never extend that time. An earlier freshness check discovering deletion does not immediately discard an otherwise usable saved B catalogue.
- At the existing 60-day refresh boundary, a confirmed-deleted B catalogue can no longer serve as current comparison input. An explicitly cleared or absent B catalogue is also unavailable; do not recreate it from old comparison results.
- When B has no usable saved catalogue, fall back to the lowest numeric remaining usable candidate still reported by Plex, A in the two-candidate example. Load or reuse A through the existing provider catalogue policies. Do not keep comparing against B's expired deleted catalogue merely because its bytes remain in storage.
- Preserve the user's B override and show both **Preferred: B** and **Currently using: A** in the report. Fallback does not overwrite or delete the override.
- Keep retrying the preferred B through the normal live-scan lookup lifecycle. If a usable B record becomes available again while Plex still reports it, resume B without requiring the user to select it again. Only a successful new download establishes a new successful-download time.
- If Plex subsequently removes a candidate, apply the candidate-removal rule above. In particular, A+B becoming A deletes the saved B override on that scan; A becomes the automatic choice.
- If no remaining candidate can supply a usable catalogue, expose a Coverage Issue and preserve available last-good results under the existing failure policy. Do not claim a current successful comparison or an empty missing list.

This confirmed-deletion behavior does not treat a timeout, authorization failure, rate limit, or unreadable response as a deleted provider record. Keep the existing retry, refresh-obligation, and Coverage Issue behavior for those failures. Provider deletion does not clear independently saved episode Manual Matches; their existing health rules still apply.

### Product-owner timeline

Days illustrate separate events; expiry is measured from the actual last successful B download.

| Day | Plex identities | Provider/cache event | Saved override | Catalogue used |
| --- | --- | --- | --- | --- |
| 1 | TMDB A; TVDB 1 | Ordinary scan | None | TMDB A; TVDB 1 |
| 100 | TMDB A+B; TVDB 1 | B appears in Plex; A is the lower ID | None | TMDB A; TVDB 1 |
| 101 | TMDB A+B; TVDB 1 | User chooses B; B catalogue is available | TMDB B | TMDB B; TVDB 1 |
| 102 | TMDB A+B; TVDB 1 | TMDB deletes B; usable B catalogue remains saved | TMDB B | Saved TMDB B; TVDB 1 |
| 163 | TMDB A+B; TVDB 1 | Saved B catalogue is beyond its 60-day limit; B lookup confirms deletion | TMDB B, still visible in report | TMDB A fallback; TVDB 1 |
| 200 | TMDB A; TVDB 1 | Plex removes B | Cleared on the next scan observing removal | Automatic TMDB A; TVDB 1 |

If B recovers before Plex removes it, a successful B lookup restores B as the comparison catalogue without losing the user's preference.

## Multiple Provider IDs report

Add a report named **Multiple Provider IDs** to the existing report navigation. It includes every scanned Plex show with more than one distinct TMDB ID or more than one distinct TVDB ID, including shows with zero missing episodes. Keep it available with an empty state when there are none.

Use one row or group per Plex show, with separate TMDB and TVDB sections as applicable. Show:

- Plex show name and identity.
- Every reported provider series name and ID, with a link to the provider record. If a record is deleted or cannot be loaded, retain its ID and any saved name with its availability state.
- The automatic lowest-ID choice, the saved override if any, and the catalogue currently used.
- Override controls for each provider with multiple candidates, including a clear-override action.
- Whether the selected catalogue is live/reusable, confirmed deleted but being used from saved data, or replaced by a fallback. For a confirmed-deleted saved catalogue, show its last successful download and the age deadline.
- Any Coverage Issue preventing a usable selection or reliable comparison.

When using a fallback, show the retained preference explicitly; do not display A as though the user selected it. For example: **Preferred: B · Currently using: A · B deleted; saved catalogue expired**.

Successful Plex inventory updates control report membership. A+B becoming A removes that provider's ambiguity and clears the override. If neither provider has multiple IDs afterward, the show leaves this report. A show with ambiguity on the other provider remains listed.

## Results notice

On each show in Plex results with multiple IDs on either provider, show a small notice identifying the affected provider and the comparison catalogue currently used. Link directly to that show's entry in Multiple Provider IDs.

Examples:

- **Multiple TMDB IDs · Using The Scooby-Doo/Dynomutt Hour (2150)**
- **Multiple TMDB IDs · Override: The Scooby-Doo Show (337142)**
- **Multiple TMDB IDs · Preferred: B · Using fallback: A**

Keep the notice small and make the report the place to inspect candidates and change the choice. The notice follows the same saved selection state as the report and comparison; the UI must not calculate a separate choice.

## Integration with scans and cached rechecks

Use the existing shared backend and ADR-0003 lifecycle. Persist the complete Plex candidate sets, saved overrides, and current catalogue selections separately so a temporary fallback cannot erase the preferred ID.

- Saving or clearing an override immediately rechecks the affected show against usable saved inputs, records applicable next-scan refresh obligations, and preserves unrelated results.
- When required saved inputs are unavailable, preserve available last-good results and expose the existing pending/Coverage Issue state. Do not compare the new catalogue selection using a previous catalogue's episode list.
- Saving an override does not start or queue a full library scan or independently download provider catalogues. The next user-run scan loads the required data through existing freshness policies.
- Reject selection mutations while a Plex scan is active, including an editor opened before that scan. The UI must display the persisted state after a rejected mutation.
- A successful scan refreshes candidate sets and reconciles override removal before choosing the catalogue used by the shared comparison.
- Keep provider refresh obligations and successful-download timestamps independent of override persistence. An unavailable preferred B and a successfully usable fallback A are distinct provider-catalogue outcomes.
- Retain all reported series IDs for reporting and existing identity evidence; choosing one comparison catalogue does not merge Plex shows or declare their episodes equivalent.

## Acceptance criteria

1. Reversing Plex GUID order produces the same automatic lowest-ID choice for both TMDB and TVDB.
2. Numeric ordering is used: ID 9 sorts before ID 10. Repeated IDs do not create ambiguity.
3. A newly added lower ID changes the automatic choice when no override exists; a saved override survives any additions and reordering.
4. The user can choose only a currently Plex-reported candidate, and can clear the override. TMDB and TVDB choices operate independently.
5. A+B becoming A clears an A override and automatically selects A; A+B becoming B clears an A override and automatically selects B. Inventory failures do not trigger either removal.
6. A provider-confirmed deletion preserves an override and usable saved catalogue while Plex still reports its ID. Lookup failures other than confirmed deletion retain the existing failure semantics.
7. Confirmed-deleted B remains usable before the 60-day age deadline, including after a refresh attempt confirms deletion. At the refresh boundary it cannot be used as current input; fallback A is used if available. Reuse never renews the deadline.
8. Fallback A remains separately identified from the B override across scans and restarts. B recovering restores use of B. Plex removing a candidate reconciles and clears the provider override under criterion 5.
9. The product-owner timeline above passes as one end-to-end lifecycle, including unchanged TVDB selection and the report retaining B while A is used.
10. The report lists fully collected as well as missing shows, displays all candidate names/IDs and preferred/current distinctions, and remains available when empty. Results notices link to the correct show entry.
11. Cached rechecks, next-scan refresh obligations, active-scan mutation protection, and provider failure reporting follow the shared backend rules. Missing saved inputs never manufacture a successful comparison.
12. Existing episode ownership decisions, coordinate matching, crosswalks, Manual Matches, and Report Missing remain unchanged for the same inventory and selected catalogues. No transitive or same-provider episode equivalence is introduced.

## Deliberate trade-offs

Lowest ID is a deterministic default, not proof that a catalogue best describes the local files. The report and override provide the correction mechanism. A newly added lower ID can change an automatic choice by design.

Different catalogues can number different stories identically. Existing coordinate-based matching is deliberately retained; this feature controls catalogue selection and makes ambiguity visible without broadening into an episode-matching redesign.

This specification revisits ADR-0002's proposed exclusion of primary-catalogue selection UI for the specific case of multiple Plex-reported provider IDs. It does not introduce that ADR's broader manual show associations or arbitrary provider series entry.
