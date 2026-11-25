import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { ManualCoverageManager } from "../app/components/manual-coverage-manager";
import { ManualMatchCard } from "../app/components/manual-match-card";
import type { CoverageMapping, CoverageMember } from "../lib/manual-coverage-model";
import { mountDom } from "./dom-environment";

// Show year (GLOSSARY.md) on Manual Match cards: part of the show name, then the show ID.
const tmdb: CoverageMember = { provider: "TMDB", id: 1001, showId: 57243, show: "Doctor Who", title: "Rose", season: 1, episode: 1, url: "https://www.themoviedb.org/tv/57243/season/1/episode/1", showYear: 2005 };
const tvdb: CoverageMember = { provider: "TVDB", id: 2001, showId: 78804, show: "Doctor Who", title: "Rose", season: 1, episode: 1, url: "https://thetvdb.com/series/doctor-who-2005/episodes/2001", showYear: 2005 };
const match: CoverageMapping = { id: "rose", revision: 1, members: [tmdb, tvdb], createdAt: "2026-11-01T00:00:00Z" };

async function renderCard(t: test.TestContext, members: CoverageMember[]) {
  const { container, root } = mountDom(t);
  await act(async () => root.render(createElement(ManualMatchCard, { match: { ...match, members }, locked: false, onEdit() {}, onDelete() {} })));
  const card = container.querySelector("article")!;
  const panel = (provider: string) => [...card.querySelectorAll(".manual-match-panels > section")].find(section => section.querySelector("header")?.textContent?.startsWith(provider))!;
  return { card, panel };
}

test("each column names its show with its year, in the show name, then the show ID", async t => {
  const ui = await renderCard(t, [tmdb, tvdb]);
  for (const provider of ["TMDB", "TVDB"]) {
    const header = ui.panel(provider).querySelector("header")!;
    assert.equal(header.querySelector("strong")?.textContent, "Doctor Who (2005)", "the year is inside the show name element");
    assert.equal(header.querySelector("strong")?.children.length, 0, "no separate year node inside the name");
    assert.deepEqual([...header.children].map(child => child.textContent), [provider, "Doctor Who (2005)", `Show ${provider === "TMDB" ? 57243 : 78804}`, "1 episode"]);
  }
  assert.equal(ui.card.querySelectorAll("small").length, 0, "no smaller secondary year");
});

test("a show with no known year is named only, never (0) or (NaN)", async t => {
  const ui = await renderCard(t, [{ ...tmdb, showYear: undefined }, { ...tvdb, showYear: 0 }]);
  assert.equal(ui.panel("TMDB").querySelector("header strong")?.textContent, "Doctor Who");
  assert.equal(ui.panel("TVDB").querySelector("header strong")?.textContent, "Doctor Who");
  assert.doesNotMatch(ui.card.textContent || "", /\((0|NaN|undefined)\)/);
});

test("a show whose year is not a four-digit year is named only, as everywhere else", async t => {
  const ui = await renderCard(t, [{ ...tmdb, showYear: 20050 }, { ...tvdb, showYear: 999 }]);
  assert.equal(ui.panel("TMDB").querySelector("header strong")?.textContent, "Doctor Who");
  assert.equal(ui.panel("TVDB").querySelector("header strong")?.textContent, "Doctor Who");
});

test("a column holding several shows labels each show with its own year", async t => {
  const classic: CoverageMember = { ...tvdb, id: 2002, showId: 76107, show: "Doctor Who", url: "https://thetvdb.com/series/doctor-who/episodes/2002", showYear: 1963 };
  const unknown: CoverageMember = { ...tvdb, id: 2003, showId: 99999, show: "Doctor Who", url: "https://thetvdb.com/series/doctor-who-x/episodes/2003", showYear: undefined };
  const ui = await renderCard(t, [tmdb, tvdb, classic, unknown]);
  assert.deepEqual([...ui.panel("TVDB").querySelectorAll(".manual-match-show-heading")].map(heading => [heading.querySelector("strong")?.textContent, heading.textContent]), [
    ["Doctor Who (2005)", "Doctor Who (2005)Show 78804"],
    ["Doctor Who (1963)", "Doctor Who (1963)Show 76107"],
    ["Doctor Who", "Doctor WhoShow 99999"],
  ]);
});

test("the Plex page's Saved Manual Matches show the same labels", async t => {
  const { container, root } = mountDom(t, { fetch: async (input: unknown) => {
    if (String(input) === "/api/plex/scan") return Response.json({ scan: { status: "completed" } });
    return Response.json({ mappings: [match], revision: 1, pending: 0 });
  } });
  await act(async () => root.render(createElement(ManualCoverageManager, { initialUrls: [tvdb.url], onClose() {}, onChanged() {} })));
  const card = container.querySelector("article")!;
  assert.ok(card, "the saved match is shown as a card");
  assert.deepEqual([...card.querySelectorAll(".manual-match-panels header strong")].map(name => name.textContent), ["Doctor Who (2005)", "Doctor Who (2005)"]);
});
