import assert from "node:assert/strict";
import test from "node:test";
import { resolvedTmdbMatchEpisode } from "../lib/plex-auto-match";

test("TMDB external-ID reports use the exact matched episode and parent series", () => {
  assert.deepEqual(resolvedTmdbMatchEpisode({
    tmdbEpisodeId: 9001,
    matched: { id: 9001, show_id: 222, season_number: 3, episode_number: 7, name: "Actual TMDB Episode", air_date: "2026-08-15" },
    local: { title: "Plex fallback", season: 6, episode: 1 },
    fallbackShow: "Primary series",
    fallbackSeason: 6,
    fallbackEpisode: 1,
    primaryShowId: 111,
    matchedShowTitle: "Alternate TMDB series",
  }), {
    id: 9001,
    showId: 222,
    show: "Alternate TMDB series",
    name: "Actual TMDB Episode",
    season: 3,
    episode: 7,
    airDate: "2026-08-15",
    url: "https://www.themoviedb.org/tv/222/season/3/episode/7",
  });
});
