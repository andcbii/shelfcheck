import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ManualMatchEditor } from "../app/components/manual-match-editor";

type Provider = "TMDB" | "TVDB";
type Show = { showId: number; show: string; showYear?: number; season?: number; episode?: number };
type Mapping = { id: string; revision: number; createdAt: string; members: unknown[] };
let nextEpisodeId = 1;
// A saved Manual Match holding one episode of each listed TMDB and TVDB show.
function match(id: string, tmdb: Show[], tvdb: Show[], createdAt = "2026-01-01T00:00:00.000Z", revision = 1): Mapping {
  const member = (provider: Provider, { season = 1, episode = 1, ...show }: Show) => ({ provider, id: nextEpisodeId++, title: "Episode", url: `https://example.test/${provider}/${nextEpisodeId}`, season, episode, ...show });
  return { id, revision, createdAt, members: [...tmdb.map(show => member("TMDB", show)), ...tvdb.map(show => member("TVDB", show))] };
}

// Mounts the Manual Matches report with a mocked Manual Coverage read and drives its show filters.
async function mount(t: TestContext, mappings: Mapping[]) {
  const browser = new Window({ url: "http://localhost/reports/manual-matches" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const fetch = async (input: unknown) => Response.json(String(input) === "/api/plex/scan" ? { scan: { status: "completed" } } : { mappings, revision: 1, pending: 0 });
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  });
  await act(async () => root.render(createElement(ManualMatchEditor, { initialUrls: [], onChanged() {}, report: true })));
  // The filter's combobox, found by its label as a screen reader would.
  const combobox = (name: string) => {
    const label = [...container.querySelectorAll("label")].find(item => item.textContent === name);
    assert.ok(label, `${name} label`);
    const input = container.querySelector<HTMLInputElement>(`#${label.htmlFor}`);
    assert.equal(input?.getAttribute("role"), "combobox");
    return input!;
  };
  const listbox = (name: string) => {
    const id = combobox(name).getAttribute("aria-controls");
    return id ? container.querySelector<HTMLElement>(`#${id}[role="listbox"]`) : null;
  };
  const key = (name: string, key: string) => act(async () => { combobox(name).dispatchEvent(new browser.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event); });
  const open = async (name: string) => { await act(async () => combobox(name).focus()); if (!listbox(name)) await key(name, "ArrowDown"); };
  const options = (name: string) => [...(listbox(name)?.querySelectorAll<HTMLElement>('[role="option"]') || [])];
  const optionLabels = async (name: string) => { await open(name); return options(name).map(option => option.textContent); };
  // react-dom loads before the DOM globals exist, so it watches the focused field's value on keyup.
  const type = (name: string, value: string) => act(async () => {
    const input = combobox(name);
    input.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new browser.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
  const pick = async (name: string, ...labels: string[]) => {
    await open(name);
    for (const label of labels) {
      const option = options(name).find(item => item.textContent === label);
      assert.ok(option, `${label} option`);
      await act(async () => option.click());
    }
  };
  const cards = () => [...container.querySelectorAll<HTMLInputElement>("article input[type=checkbox]")].map(input => input.getAttribute("aria-label")!.replace("Select Manual Match ", ""));
  const heading = () => [...container.querySelectorAll("h3")].map(item => item.textContent).find(text => text?.startsWith("Manual Matches"));
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label);
    assert.ok(button, `${label} button`);
    await act(async () => button.click());
  };
  return { container, combobox, listbox, options, optionLabels, open, key, type, pick, cards, heading, click };
}

const day = (n: number) => `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;
const lost = { showId: 900, show: "Lost", showYear: 2004 };

for (const [order, reverse] of [["API", false], ["reversed API", true]] as const) {
  test(`TMDB shows lists one option per saved show ID, named from its newest-created match, in the report's show order (${order} order)`, async t => {
    const mappings = [
      match("who-1963-old", [{ showId: 121, show: "Dr. Who", showYear: 1963 }], [lost], day(1), 7),
      match("who-1963-new", [{ showId: 121, show: "Doctor Who", showYear: 1963 }], [lost], day(5)),
      match("who-2005", [{ showId: 57243, show: "Doctor Who", showYear: 2005 }], [lost], day(2)),
      // Equal creation times: the higher mapping ID counts as the newer match.
      match("archer-2", [{ showId: 1000, show: "Archer", showYear: 2009 }], [lost], day(3)),
      match("archer-1", [{ showId: 1000, show: "Archer (old)" }], [lost], day(3)),
      match("zoo", [{ showId: 7, show: "Zoo" }], [lost], day(4)),
    ];
    const report = await mount(t, reverse ? mappings.reverse() : mappings);
    assert.deepEqual(await report.optionLabels("TMDB shows"), ["Archer (2009)", "Doctor Who (1963)", "Doctor Who (2005)", "Zoo"]);
    assert.deepEqual(await report.optionLabels("TVDB shows"), ["Lost (2004)"]);
  });
}

const who1963 = { showId: 121, show: "Doctor Who", showYear: 1963 };
const who2005 = { showId: 57243, show: "Doctor Who", showYear: 2005 };
const archer = { showId: 1000, show: "Archer", showYear: 2009 };
const tvdbWho = { showId: 76107, show: "Doctor Who", showYear: 1963 };
const tvdbWho2005 = { showId: 78804, show: "Doctor Who", showYear: 2005 };
const tvdbArcher = { showId: 110381, show: "Archer", showYear: 2009 };
const filtered = () => [
  match("archer", [archer], [tvdbArcher]),
  match("who-1963", [who1963], [tvdbWho]),
  match("who-2005", [who2005], [tvdbWho2005]),
  // A TMDB 2005 episode matched to a 1963 TVDB episode, and a card spanning two TMDB shows.
  match("who-crossed", [{ ...who2005, episode: 2 }], [{ ...tvdbWho, episode: 2 }]),
  match("spanning", [{ ...archer, season: 9 }, { ...who1963, season: 9 }], [{ ...tvdbArcher, season: 9 }]),
];

test("Typing narrows a show filter's options by name", async t => {
  const report = await mount(t, filtered());
  await report.open("TMDB shows");
  await report.type("TMDB shows", "doctor");
  assert.deepEqual(report.options("TMDB shows").map(option => option.textContent), ["Doctor Who (1963)", "Doctor Who (2005)"]);
  await report.type("TMDB shows", "2005");
  assert.deepEqual(report.options("TMDB shows").map(option => option.textContent), ["Doctor Who (2005)"]);
  await report.type("TMDB shows", "Columbo");
  assert.deepEqual(report.options("TMDB shows"), []);
  assert.match(report.container.textContent!, /No shows match/);
});

test("Same-named shows filter by show ID, and picks in one filter combine with OR", async t => {
  const report = await mount(t, filtered());
  assert.equal(report.heading(), "Manual Matches (5)");
  await report.pick("TMDB shows", "Doctor Who (2005)");
  assert.deepEqual(report.cards(), ["who-2005", "who-crossed"]);
  assert.equal(report.heading(), "Manual Matches (2 of 5)");
  await report.pick("TMDB shows", "Archer (2009)");
  assert.deepEqual(report.cards(), ["archer", "spanning", "who-2005", "who-crossed"]);
  assert.deepEqual(report.options("TMDB shows").filter(option => option.getAttribute("aria-selected") === "true").map(option => option.textContent), ["Archer (2009)", "Doctor Who (2005)"]);
});

test("A match belongs to every show on its side, and the two filters combine with AND", async t => {
  const report = await mount(t, filtered());
  await report.pick("TMDB shows", "Doctor Who (1963)");
  assert.deepEqual(report.cards(), ["spanning", "who-1963"]);
  await report.pick("TVDB shows", "Archer (2009)");
  assert.deepEqual(report.cards(), ["spanning"]);
  assert.equal(report.heading(), "Manual Matches (1 of 5)");
  await report.click("Remove Doctor Who (1963)");
  assert.deepEqual(report.cards(), ["archer", "spanning"]);
});

test("A show filter works from the keyboard", async t => {
  const report = await mount(t, filtered());
  const combobox = report.combobox("TMDB shows");
  await act(async () => combobox.focus());
  assert.equal(combobox.getAttribute("aria-expanded"), "true");
  const active = () => report.container.querySelector(`#${combobox.getAttribute("aria-activedescendant")}`)?.textContent;
  assert.equal(active(), "Archer (2009)");
  await report.key("TMDB shows", "ArrowDown");
  await report.key("TMDB shows", "ArrowDown");
  assert.equal(active(), "Doctor Who (2005)");
  await report.key("TMDB shows", "Enter");
  await report.key("TMDB shows", "ArrowUp");
  await report.key("TMDB shows", "Enter");
  assert.deepEqual(report.cards(), ["spanning", "who-1963", "who-2005", "who-crossed"]);
  await report.key("TMDB shows", "Enter");
  assert.deepEqual(report.cards(), ["who-2005", "who-crossed"]);
  await report.key("TMDB shows", "Escape");
  assert.equal(combobox.getAttribute("aria-expanded"), "false");
  assert.equal(report.listbox("TMDB shows"), null);
});

test("Clear filters empties both filters when no Manual Match matches them", async t => {
  const report = await mount(t, filtered());
  await report.pick("TMDB shows", "Doctor Who (2005)");
  await report.pick("TVDB shows", "Archer (2009)");
  assert.deepEqual(report.cards(), []);
  assert.equal(report.heading(), "Manual Matches (0 of 5)");
  assert.match(report.container.textContent!, /No Manual Matches match these filters/);
  assert.doesNotMatch(report.container.textContent!, /Create a Manual Match to link/);
  await report.click("Clear filters");
  assert.equal(report.heading(), "Manual Matches (5)");
  assert.equal(report.cards().length, 5);
  assert.deepEqual(await report.optionLabels("TMDB shows").then(() => report.options("TMDB shows").filter(option => option.getAttribute("aria-selected") === "true")), []);
  assert.deepEqual(await report.optionLabels("TVDB shows").then(() => report.options("TVDB shows").filter(option => option.getAttribute("aria-selected") === "true")), []);
  assert.doesNotMatch(report.container.textContent!, /No Manual Matches match these filters/);
});

test("With no saved Manual Matches the report keeps its empty state and offers no show filters", async t => {
  const report = await mount(t, []);
  assert.equal(report.heading(), "Manual Matches (0)");
  assert.match(report.container.textContent!, /No Manual Matches.*Create a Manual Match to link/);
  assert.equal(report.container.querySelector('[role="combobox"]'), null);
});

test("Paging works over the filtered list and clamps the current page", async t => {
  // Twelve Lost matches and two Archer matches, which sort first.
  const mappings = [
    ...Array.from({ length: 12 }, (_, index) => match(`lost-${String(index + 1).padStart(2, "0")}`, [{ showId: 4607, show: "Lost", showYear: 2004, episode: index + 1 }], [lost])),
    match("archer-1", [archer], [tvdbArcher]),
    match("archer-2", [{ ...archer, episode: 2 }], [tvdbArcher]),
  ];
  const report = await mount(t, mappings);
  await report.click("Next →");
  assert.deepEqual(report.cards(), ["lost-09", "lost-10", "lost-11", "lost-12"]);
  await report.pick("TMDB shows", "Lost (2004)");
  assert.deepEqual(report.cards(), ["lost-11", "lost-12"]);
  await report.pick("TMDB shows", "Lost (2004)");
  await report.pick("TMDB shows", "Archer (2009)");
  assert.deepEqual(report.cards(), ["archer-1", "archer-2"]);
  assert.match(report.container.querySelector(".report-pagination")!.textContent!, /Showing 1–2 of 2.*1 \/ 1/);
});

test("A show ID saved under two names keeps its cards together, in the show filter's option order", async t => {
  const mappings = [
    match("who-old-name", [{ showId: 121, show: "Dr. Who", showYear: 1963, episode: 1 }], [lost], day(1)),
    match("downton", [{ showId: 33907, show: "Downton Abbey", showYear: 2010 }], [lost], day(2)),
    match("who-new-name", [{ showId: 121, show: "Doctor Who", showYear: 1963, episode: 2 }], [lost], day(3)),
  ];
  const report = await mount(t, mappings);
  assert.deepEqual(await report.optionLabels("TMDB shows"), ["Doctor Who (1963)", "Downton Abbey (2010)"]);
  assert.deepEqual(report.cards(), ["who-old-name", "who-new-name", "downton"]);
});
