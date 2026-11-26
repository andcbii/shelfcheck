# Shelfcheck 2.7.3

Shelfcheck 2.7.3 makes the 01 Manual Matches report easier to search and
read: every show carries its year, cards are in show order, and two show
filters narrow the report to the matches you want. Nothing migrates; years
fill in after the first completed full Plex scan.

## Show years on Manual Matches

- Each show on a Manual Match card reads "Show Name (Year)", followed by its
  show ID, so Doctor Who (1963) and Doctor Who (2005) are easy to tell apart.
- The year is the one Plex gives the show in the latest completed full Plex
  scan, the same year the Plex page shows. A show not in Plex, or held by
  Plex shows with different years, uses its TMDB or TVDB year.
- Only a completed full scan changes years. Single-show scans, rechecks and
  Clear cache keep them, and the Plex page now keeps the full scan's year
  after a single-show scan too.

## Sorting and filtering the Manual Matches report

- Cards are always in show order: TMDB show name, year (no year last), show
  ID, then season and episode.
- Two new filters, TMDB shows and TVDB shows: type part of a name and pick
  one or more shows. Picks in one filter mean any of them; picks in both
  filters must both match.
- While a filter is on, the heading reads "Manual Matches (5 of 120)". If
  nothing matches, the page says so and offers Clear filters.
- Changing a filter unticks matches, and Select all and bulk delete only
  cover the matches you can see.
- Saving a match the filters hide keeps your filters and says "Saved. Hidden
  by the current filters." Filters reset when you leave or reload the page.

## Unchanged

- The Trakt page keeps Trakt's year.
- Candidate shows on the Provider Matches and Multiple Provider IDs reports
  keep their provider years.
- The Plex page's Saved Manual Matches list keeps its order and has no
  filters.

## Upgrading

Nothing migrates. Until the first completed full Plex scan, existing Manual
Matches show names without years, except matches you save, which pick up
their TMDB or TVDB year when saved. Saved matches, Report Missing flags and
coverage are untouched.
