import { matchesSearch } from "./search";

/** A calendar date written as YYYY-MM-DD, with no time and no time zone. */
export type CalendarDate = string;

/**
 * How the Aired rule treats missing episodes:
 * - "show-all": every episode shows (Plex with "Hide unaired episodes" off).
 * - "aired-only": only an episode with a usable air date whose air date plus the
 *   Air-date delay is today or earlier (Plex with "Hide unaired episodes" on).
 * - "aired-or-undated": as "aired-only", but an episode with no usable air date shows.
 */
export type AiredPolicy = "show-all" | "aired-only" | "aired-or-undated";

export type ResultsViewEpisode = { season: number; airDate?: string };

export type ResultsViewShowInput<S, E extends ResultsViewEpisode, K = string> = {
  key: K;
  title: string;
  source: S;
  episodes: readonly E[];
};

export type ResultsViewInput<S, E extends ResultsViewEpisode, K = string> = {
  shows: readonly ResultsViewShowInput<S, E, K>[];
  /** Keys of shows with an Active ignore. */
  ignoredShows: ReadonlySet<K>;
  /** Seasons with an Active ignore, by show key. */
  ignoredSeasons: ReadonlyMap<K, ReadonlySet<number>>;
  airedPolicy: AiredPolicy;
  airDateDelayDays: number;
  today: CalendarDate;
  search: string;
  sortField: "title" | "percent";
  sortAscending: boolean;
  /** The show's percent, given its episodes left after Active ignores and the Aired rule. */
  percent: (show: S, episodes: readonly E[]) => number;
};

export type ResultsViewShow<S, E extends ResultsViewEpisode, K = string> = {
  key: K;
  title: string;
  source: S;
  episodes: E[];
  percent: number;
};

export type ResultsView<S, E extends ResultsViewEpisode, K = string> = {
  /** Shows to draw: filtered, searched and sorted. */
  shows: ResultsViewShow<S, E, K>[];
  /** Totals after Active ignores and the Aired rule, before search. */
  totals: { missingEpisodes: number; shows: number };
};

export function resultsView<S, E extends ResultsViewEpisode, K = string>(input: ResultsViewInput<S, E, K>): ResultsView<S, E, K> {
  const remaining = input.shows.filter((show) => !input.ignoredShows.has(show.key)).map((show) => {
    const ignoredSeasons = input.ignoredSeasons.get(show.key);
    const episodes = show.episodes.filter((episode) => !ignoredSeasons?.has(episode.season) && isShownByAiredRule(episode, input));
    return { key: show.key, title: show.title, source: show.source, episodes };
  }).filter((show) => show.episodes.length).map((show) => ({ ...show, percent: input.percent(show.source, show.episodes) }));
  const totals = { missingEpisodes: remaining.reduce((sum, show) => sum + show.episodes.length, 0), shows: remaining.length };
  const direction = input.sortAscending ? 1 : -1;
  const shows = remaining.filter((show) => matchesSearch(show.title, input.search)).sort((a, b) => {
    const order = input.sortField === "percent" ? a.percent - b.percent || a.title.localeCompare(b.title) : a.title.localeCompare(b.title);
    return order * direction;
  });
  return { shows, totals };
}

function isShownByAiredRule(episode: ResultsViewEpisode, input: { airedPolicy: AiredPolicy; airDateDelayDays: number; today: CalendarDate }) {
  if (input.airedPolicy === "show-all") return true;
  const airDate = parseCalendarDate(episode.airDate);
  if (!airDate) return input.airedPolicy === "aired-or-undated";
  return addCalendarDays(airDate, input.airDateDelayDays) <= input.today;
}

/** The calendar date of the given moment in the runtime's local time zone (the browser's, on a page). */
export function localCalendarDate(moment: Date): CalendarDate {
  return formatCalendarDate({ year: moment.getFullYear(), month: moment.getMonth() + 1, day: moment.getDate() });
}

/** Returns the value when it is a real YYYY-MM-DD calendar date, otherwise undefined. */
export function parseCalendarDate(value: unknown): CalendarDate | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number);
  const roundTrip = civilFromDays(daysFromCivil(year, month, day));
  return roundTrip.year === year && roundTrip.month === month && roundTrip.day === day ? value : undefined;
}

export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const [year, month, day] = date.split("-").map(Number);
  return formatCalendarDate(civilFromDays(daysFromCivil(year, month, day) + days));
}

function formatCalendarDate({ year, month, day }: { year: number; month: number; day: number }): CalendarDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Proleptic Gregorian day counting (H. Hinnant's days_from_civil / civil_from_days),
// in whole calendar days: no clock, no time zone, no 24-hour periods.
function daysFromCivil(year: number, month: number, day: number) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(days: number) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth + (shiftedMonth < 10 ? 3 : -9);
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}
