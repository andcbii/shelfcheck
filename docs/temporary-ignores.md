# Temporary ignores

Status: implemented locally. The canonical specification is [GitHub issue #3](https://github.com/andcbii/shelfcheck/issues/3).

## Confirmed behavior

- Offer temporary ignores in both Plex and Trakt, for whole shows and selected seasons.
- Keep existing permanent ignores permanent.
- Clicking Ignore opens a chooser with 30 days, 90 days, 6 months, and Forever.
- Count 30 and 90 days from the moment selected. Six months means six calendar months, clamping to the last valid day when necessary.
- Expiry automatically ends the ignore and makes the show eligible for the next scan. Expiry does not start a scan.
- Show expiry dates in Ignored Shows, or Forever for permanent ignores.
- Allow the duration to be changed and allow immediate Restore.
- Changing a duration starts a new period from the moment of the change, replacing the previous deadline. Changing to Forever removes the deadline.
- Selected seasons of one show share one duration; changing that duration affects the whole selection.
- Editing the selected seasons without changing the duration preserves the existing deadline.
- Whole-show and season ignores remain independent. Restoring or expiring the whole-show ignore leaves any active season ignore in effect.
- Expired ignores disappear from the manager and its count. Do not keep an expiry history.
- Applying a whole-show ignore removes that show's saved results immediately. Expiry or Restore requires a new scan to obtain results. Season ignores remain filters over existing results, so those results can reappear when the season ignore ends.
- Use the selecting device's local calendar for six-month arithmetic and show expiry as a local date and time.
- Each scan fixes its candidate selection at its start. A show whose ignore expires during the scan waits until the following scan.

## Acceptance scenarios

- A legacy ignore without an expiry continues to show Forever after upgrading or restarting.
- A 30-day or 90-day ignore ends at the selected instant plus exactly that many days. Six months follows the device's calendar and clamps the day to the target month's last valid day if necessary.
- A deadline equal to the current instant has expired. Returning to an open tab or leaving it open through expiry updates the active ignores and count without starting a scan.
- Changing a 90-day ignore to 30 days creates a deadline 30 days from the change; changing it to Forever prevents automatic expiry.
- A season selection has one deadline, and changing its duration preserves the selected seasons, including when the show is absent from the latest report.
- A whole-show ignore hides the show and removes its saved result immediately. Ending the ignore does not resurrect old results, including when a scan was already running when the ignore was applied.
- If a whole-show ignore ends while a separate season ignore remains, a new scan can return the show with those seasons still hidden.
- Season-ignore expiry reveals any previously filtered episodes already present in the report. It does not require an automatic scan.
- A scan that starts before a whole-show ignore expires does not include that show even if it expires before the scan completes.

## Implementation direction

- Extend existing ignore records with an optional absolute expiry. Missing expiry means Forever; preserve it through preference parsing and client hydration.
- Persist a deadline once when the duration is applied. Restarts, reads, and scans must not restart the clock.
- Share active-ignore rules across scanner filtering, result filtering, management, and counts. Re-evaluate on page focus and at expiry; no background scheduler is required.
- Prune whole-show results and associated cached/checkpoint data when applying an ignore, and prevent in-flight scan writes from resurrecting those results.
- Preserve the existing ignored-count convention: count active whole-show records and season-group records separately.
- Keep Plex and Trakt preferences independent, retaining the existing whole-show scan exclusions and season display filtering.
- Validate calendar boundaries, exact expiry, legacy records, serialization, overlapping ignores, report/cache removal, and scan-time behavior. Run the relevant tests, lint, and build during implementation.

## Existing behavior relevant to the design

- Plex and Trakt keep separate preferences. Whole-show ignores skip show-specific scan work; season ignores hide missing episodes in the results.
- Whole-show and season ignores are stored separately. A season-ignore record currently contains all selected seasons for a show.
- The ignored count currently counts whole-show records plus season selections, so the same show can contribute twice.
- Ignore preference updates currently retain saved reports and caches. Restoring before another scan can reveal the retained result; scans while ignored omit that show from the replacement report. README currently describes immediate removal instead.
- Scans take their ignore preferences at the start; there is no expiry scheduler or idle-page expiry refresh.

These observations describe the code reviewed during the interview; the confirmed behavior above defines the intended change.
