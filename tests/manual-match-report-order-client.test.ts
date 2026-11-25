import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { act, createElement } from "react";
import { ManualMatchEditor } from "../app/components/manual-match-editor";
import { mountDom } from "./dom-environment";
import { cardIds, savedMatch, type SavedMatch, type ShowEpisode } from "./manual-match-members";

// A saved Manual Match whose TMDB side holds `tmdb` and whose TVDB side holds one episode.
const match = (id: string, tmdb: ShowEpisode[]) => savedMatch(id, tmdb, [{ showId: 900, show: "Other" }]);

// Mounts the Manual Match editor with a mocked Manual Coverage read and returns the cards' Manual Match IDs in order.
async function mount(t: TestContext, mappings: SavedMatch[], report = true) {
  const { container, root } = mountDom(t, { fetch: async (input: unknown) => Response.json(String(input) === "/api/plex/scan" ? { scan: { status: "completed" } } : { mappings, revision: 1, pending: 0 }) });
  await act(async () => root.render(createElement(ManualMatchEditor, { initialUrls: [], onChanged() {}, report })));
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(item => item.textContent === label);
    assert.ok(button, `${label} button`);
    await act(async () => button.click());
  };
  return { cards: () => cardIds(container), click };
}

test("Manual Matches report orders a show's matches by season and episode as numbers", async t => {
  const show = { showId: 10, show: "Lost" };
  const mappings = [
    match("s1e10", [{ ...show, season: 1, episode: 10 }]),
    match("s2e1", [{ ...show, season: 2, episode: 1 }]),
    match("s1e2", [{ ...show, season: 1, episode: 2 }]),
    match("s10e1", [{ ...show, season: 10, episode: 1 }]),
  ];
  const report = await mount(t, mappings);
  assert.deepEqual(report.cards(), ["s1e2", "s1e10", "s2e1", "s10e1"]);
});

const episode = { season: 1, episode: 1 };
const shows = [
  match("who-unknown", [{ showId: 5, show: "Doctor Who", ...episode }]),
  match("who-2005", [{ showId: 57243, show: "Doctor Who", showYear: 2005, ...episode }]),
  match("archer", [{ showId: 1000, show: "Archer", showYear: 2009, season: 3, episode: 4 }]),
  match("who-1963-b", [{ showId: 121, show: "Doctor Who", showYear: 1963, ...episode }]),
  match("who-1963-a", [{ showId: 121, show: "Doctor Who", showYear: 1963, ...episode }]),
  match("who-1963-lower-id", [{ showId: 120, show: "Doctor Who", showYear: 1963, season: 9, episode: 9 }]),
  match("zoo", [{ showId: 1, show: "Zoo", showYear: 2015, ...episode }]),
];
test("Manual Matches report anchors a card spanning several TMDB shows on the first show and that show's lowest episode", async t => {
  const archer = { showId: 1000, show: "Archer", showYear: 2009 };
  const mappings = [
    match("archer-s3e1", [{ ...archer, season: 3, episode: 1 }]),
    match("spanning", [{ showId: 1, show: "Zoo", showYear: 2015, season: 1, episode: 1 }, { ...archer, season: 5, episode: 3 }, { ...archer, season: 2, episode: 7 }]),
    match("archer-s2e8", [{ ...archer, season: 2, episode: 8 }]),
    match("archer-s1e5", [{ ...archer, season: 1, episode: 5 }]),
    match("zoo-s1e2", [{ showId: 1, show: "Zoo", showYear: 2015, season: 1, episode: 2 }]),
  ];
  assert.deepEqual((await mount(t, mappings)).cards(), ["archer-s1e5", "spanning", "archer-s2e8", "archer-s3e1", "zoo-s1e2"]);
});

// Twelve episodes of one show saved newest-first, so the API order is the reverse of the report order.
const twelve = Array.from({ length: 12 }, (_, index) => match(`e${String(12 - index).padStart(2, "0")}`, [{ showId: 10, show: "Lost", season: 1, episode: 12 - index }]));

test("Manual Matches report pages through the ordered list", async t => {
  const report = await mount(t, twelve);
  assert.deepEqual(report.cards(), ["e01", "e02", "e03", "e04", "e05", "e06", "e07", "e08", "e09", "e10"]);
  await report.click("Next →");
  assert.deepEqual(report.cards(), ["e11", "e12"]);
});

test("Saved Manual Matches outside the report keep the saved order", async t => {
  const list = await mount(t, twelve, false);
  assert.deepEqual(list.cards(), twelve.slice(0, 10).map(mapping => mapping.id));
});

for (const [order, mappings] of [["API", shows], ["reversed API", [...shows].reverse()]] as const) {
  test(`Manual Matches report orders shows by name, then Show year with no year last, then show ID, then Manual Match ID (${order} order)`, async t => {
    assert.deepEqual((await mount(t, mappings)).cards(), ["archer", "who-1963-lower-id", "who-1963-a", "who-1963-b", "who-2005", "who-unknown", "zoo"]);
  });
}
