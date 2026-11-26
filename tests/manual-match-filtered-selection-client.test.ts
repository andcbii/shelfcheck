import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { ManualMatchEditor } from "../app/components/manual-match-editor";
import type { CoverageMember } from "../lib/manual-coverage-model";
import { mountDom } from "./dom-environment";
import { cardIds, reportHeading, savedMatch as match, showFilterCombobox, showMember as member, type SavedMatch } from "./manual-match-members";

const lost = { showId: 4607, show: "Lost", showYear: 2004 };
const tvdbLost = { showId: 73739, show: "Lost", showYear: 2004 };
const archer = { showId: 1000, show: "Archer", showYear: 2009 };
const tvdbArcher = { showId: 110381, show: "Archer", showYear: 2009 };
const who = { showId: 57243, show: "Doctor Who", showYear: 2005 };
const tvdbWho = { showId: 78804, show: "Doctor Who", showYear: 2005 };
const id2 = (n: number) => String(n).padStart(2, "0");
const lostMatches = (count: number) => Array.from({ length: count }, (_, index) => match(`lost-${id2(index + 1)}`, [{ ...lost, episode: index + 1 }], [{ ...tvdbLost, episode: index + 1 }]));

/**
 * The 01 Manual Matches report, mounted once, over a stubbed Manual Coverage API
 * that keeps the saved Manual Matches, records each DELETE payload, and saves a
 * reviewed edit as the members `resolveAs` gives.
 */
async function mountReport(t: test.TestContext, initial: SavedMatch[]) {
  const server = { mappings: initial, revision: 1, resolveAs: [] as CoverageMember[] };
  const deletes: string[][] = [];
  // While held, Manual Coverage GETs wait to be released and then answer with the saved state at that time.
  let held: (() => void)[] | null = null;
  const savedState = () => Response.json({ mappings: server.mappings, revision: server.revision, pending: 0 });
  const { browser, container, root } = mountDom(t, { fetch: async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/plex/scan") return Response.json({ scan: { status: "completed" } });
    if (init?.method === "DELETE") {
      const ids: string[] = init.body ? JSON.parse(String(init.body)).ids : [new URL(String(input), "http://localhost").searchParams.get("id")!];
      deletes.push(ids);
      server.mappings = server.mappings.filter(mapping => !ids.includes(mapping.id));
      return Response.json({ deleted: ids, missing: [], revision: ++server.revision });
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "resolve") return Response.json({ preview: "reviewed", members: server.resolveAs });
      const saved = { ...server.mappings.find(mapping => mapping.id === body.id)!, members: server.resolveAs, revision: body.revision + 1 };
      server.mappings = server.mappings.map(mapping => mapping.id === saved.id ? saved : mapping);
      return Response.json({ mapping: saved, revision: ++server.revision, pending: 0 });
    }
    if (held) { const queue = held; return new Promise<Response>(resolve => queue.push(() => resolve(savedState()))); }
    return savedState();
  } });
  /** Holds later Manual Coverage GETs; the returned function answers them. */
  const holdRefresh = () => {
    const queue: (() => void)[] = held = [];
    return async () => { held = null; await act(async () => queue.forEach(answer => answer())); };
  };
  await act(async () => root.render(createElement(ManualMatchEditor, { initialUrls: [], onChanged() {}, report: true })));
  const combobox = (name: string) => showFilterCombobox(container, name);
  const options = (name: string) => [...container.querySelectorAll<HTMLElement>(`#${combobox(name).getAttribute("aria-controls")} [role="option"]`)];
  const pick = async (name: string, label: string) => {
    await act(async () => combobox(name).focus());
    const option = options(name).find(item => item.textContent === label);
    assert.ok(option, `${label} option`);
    await act(async () => option.click());
  };
  const picked = (name: string) => [...container.querySelectorAll(`[aria-label="Picked ${name}"] li`)].map(item => item.textContent!.replace("×", ""));
  const button = (label: string | RegExp, scope: ParentNode = container) => {
    const found = [...scope.querySelectorAll("button")].find(item => typeof label === "string" ? item.textContent === label || item.getAttribute("aria-label") === label : label.test(item.textContent || ""));
    assert.ok(found, `${label} button`);
    return found;
  };
  const click = async (label: string | RegExp, scope: ParentNode = container) => { const found = button(label, scope); await act(async () => found.click()); };
  const card = (id: string) => {
    const found = [...container.querySelectorAll("article")].find(article => article.querySelector(`input[aria-label="Select Manual Match ${id}"]`));
    assert.ok(found, `${id} card`);
    return found;
  };
  const tick = async (...ids: string[]) => { for (const id of ids) await act(async () => card(id).querySelector<HTMLInputElement>("input[type=checkbox]")!.click()); };
  const cards = () => cardIds(container);
  const ticked = () => [...container.querySelectorAll<HTMLInputElement>("article input[type=checkbox]")].filter(input => input.checked).map(input => input.getAttribute("aria-label")!.replace("Select Manual Match ", ""));
  const bulkBar = () => container.querySelector<HTMLElement>('[aria-label="Selected Manual Matches"]')?.textContent ?? null;
  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');
  const dialogName = () => dialog()?.getAttribute("aria-label") ?? null;
  const heading = () => reportHeading(container);
  return { browser, container, root, server, deletes, holdRefresh, pick, picked, button, click, card, tick, cards, ticked, bulkBar, dialog, dialogName, heading };
}

test("Changing either show filter clears ticked matches and a pending bulk delete confirmation", async t => {
  const report = await mountReport(t, [...lostMatches(3), match("archer", [archer], [tvdbArcher])]);
  await report.pick("TMDB shows", "Lost (2004)");
  await report.tick("lost-01", "lost-02");
  await report.click("Delete 2 selected matches");
  assert.equal(report.dialogName(), "Delete Manual Matches");
  // Widening the TMDB filter keeps both ticked matches listed, yet the selection still clears.
  await report.pick("TMDB shows", "Archer (2009)");
  assert.equal(report.dialogName(), null);
  assert.equal(report.bulkBar(), null);
  assert.deepEqual(report.ticked(), []);
  await report.tick("lost-03");
  await report.pick("TVDB shows", "Lost (2004)");
  assert.equal(report.bulkBar(), null);
  assert.deepEqual(report.ticked(), []);
  assert.deepEqual(report.deletes, []);
});

test("Select all covers every filtered match across pages and none that are hidden, and bulk delete sends exactly those", async t => {
  // Twelve Lost matches span two pages; the Archer and Doctor Who matches sort around them but are filtered out.
  const report = await mountReport(t, [match("who", [who], [tvdbWho]), ...lostMatches(12), match("archer", [archer], [tvdbArcher])]);
  await report.tick("archer");
  await report.pick("TMDB shows", "Lost (2004)");
  assert.equal(report.heading(), "Manual Matches (12 of 14)");
  await report.tick("lost-01");
  await report.click("Select all 12 Manual Matches");
  assert.match(report.bulkBar()!, /^12 selected/);
  await report.click("Next →");
  assert.deepEqual(report.ticked(), ["lost-11", "lost-12"]);
  await report.click("Delete 12 selected matches");
  await report.click("Delete 12 matches", report.dialog()!);
  assert.deepEqual(report.deletes.map(ids => [...ids].sort()), [lostMatches(12).map(mapping => mapping.id)]);
  assert.deepEqual(report.server.mappings.map(mapping => mapping.id), ["who", "archer"]);
});

test("A hidden selection never survives to a later delete", async t => {
  const report = await mountReport(t, [...lostMatches(2), match("archer", [archer], [tvdbArcher])]);
  await report.tick("archer");
  await report.pick("TVDB shows", "Lost (2004)");
  await report.tick("lost-01");
  // Removing the pick lists the Archer match again, unticked.
  await report.click("Remove Lost (2004)");
  assert.deepEqual(report.ticked(), []);
  await report.tick("lost-02");
  await report.click("Delete 1 selected match");
  await report.click("Delete match", report.dialog()!);
  assert.deepEqual(report.deletes, [["lost-02"]]);
});

test("Saving a match the filters hide keeps the filters and says so; a visible save shows the Saved note", async t => {
  const report = await mountReport(t, [match("who-a", [who], [tvdbWho]), match("who-b", [{ ...who, episode: 2 }], [{ ...tvdbWho, episode: 2 }]), match("archer", [archer], [tvdbArcher])]);
  await report.pick("TMDB shows", "Doctor Who (2005)");
  await report.tick("who-a", "who-b");
  const save = async (id: string, members: CoverageMember[]) => {
    report.server.resolveAs = members;
    await report.click(/^Edit/, report.card(id));
    await report.click("Resolve and review", report.dialog()!);
    await report.click("Save Manual Match", report.dialog()!);
    assert.equal(report.dialogName(), null);
  };
  await save("who-b", [member("TMDB", { ...who, episode: 3 }), member("TVDB", { ...tvdbWho, episode: 3 })]);
  assert.equal(report.card("who-b").querySelector(".manual-match-saved")?.textContent, "Saved");
  assert.doesNotMatch(report.container.textContent!, /Hidden by the current filters/);
  // Moving who-a to Archer hides it under the Doctor Who filter.
  await save("who-a", [member("TMDB", archer), member("TVDB", tvdbArcher)]);
  assert.deepEqual(report.picked("TMDB shows"), ["Doctor Who (2005)"]);
  assert.deepEqual(report.cards(), ["who-b"]);
  assert.ok([...report.container.querySelectorAll('[role="status"]')].some(status => status.textContent === "Saved. Hidden by the current filters."));
  assert.match(report.bulkBar()!, /^1 selected/);
  // No stale selection remains: when who-a is listed again after a later refresh, it is not ticked.
  report.server.mappings = report.server.mappings.map(mapping => mapping.id === "who-a" ? { ...mapping, members: [member("TMDB", { ...who, episode: 4 }), member("TVDB", { ...tvdbWho, episode: 4 })] } : mapping);
  await save("who-b", [member("TMDB", { ...who, episode: 3 }), member("TVDB", { ...tvdbWho, episode: 3 })]);
  assert.deepEqual(report.cards(), ["who-b", "who-a"]);
  assert.deepEqual(report.ticked(), ["who-b"]);
  await report.click("Delete 1 selected match");
  await report.click("Delete match", report.dialog()!);
  assert.deepEqual(report.deletes, [["who-b"]]);
});

const deleteOne = async (report: Awaited<ReturnType<typeof mountReport>>, id: string) => {
  await report.click(/^Delete/, report.card(id));
  await report.click("Delete match", report.dialog()!);
};

test("A refresh of the same mounted report keeps the filters and ticked matches across changed show names and years", async t => {
  const report = await mountReport(t, [...lostMatches(3), match("archer", [archer], [tvdbArcher])]);
  await report.pick("TMDB shows", "Lost (2004)");
  await report.pick("TVDB shows", "Lost (2004)");
  await report.tick("lost-01", "lost-02");
  // The saved show is renamed and its year corrected before the next refresh.
  const renamed = (show: CoverageMember) => show.provider === "TMDB" && show.showId === lost.showId ? { ...show, show: "LOST", showYear: 2005 } : show;
  report.server.mappings = report.server.mappings.map(mapping => ({ ...mapping, members: mapping.members.map(renamed) }));
  await deleteOne(report, "lost-03");
  assert.deepEqual(report.deletes, [["lost-03"]]);
  assert.deepEqual(report.picked("TMDB shows"), ["LOST (2005)"]);
  assert.deepEqual(report.picked("TVDB shows"), ["Lost (2004)"]);
  assert.equal(report.heading(), "Manual Matches (2 of 3)");
  assert.deepEqual(report.cards(), ["lost-01", "lost-02"]);
  assert.deepEqual(report.ticked(), ["lost-01", "lost-02"]);
});

test("When a refresh removes a picked show's last match, the pick is dropped and the selection clears", async t => {
  const report = await mountReport(t, [match("who", [who], [tvdbWho]), ...lostMatches(1), match("archer", [archer], [tvdbArcher])]);
  await report.pick("TMDB shows", "Doctor Who (2005)");
  await report.pick("TMDB shows", "Archer (2009)");
  await report.tick("archer");
  await deleteOne(report, "who");
  assert.deepEqual(report.picked("TMDB shows"), ["Archer (2009)"]);
  assert.equal(report.heading(), "Manual Matches (1 of 2)");
  assert.deepEqual(report.cards(), ["archer"]);
  assert.equal(report.bulkBar(), null);
  // Removing the remaining pick lists everything again: no Doctor Who pick lingers to filter by.
  await report.click("Remove Archer (2009)");
  assert.equal(report.heading(), "Manual Matches (2)");
});

test("A save that moves a picked show's last match to another show drops the pick and lists the saved match", async t => {
  const report = await mountReport(t, [match("who", [who], [tvdbWho]), match("archer", [archer], [tvdbArcher])]);
  await report.pick("TMDB shows", "Doctor Who (2005)");
  report.server.resolveAs = [member("TMDB", { ...archer, episode: 2 }), member("TVDB", { ...tvdbArcher, episode: 2 })];
  await report.click(/^Edit/, report.card("who"));
  await report.click("Resolve and review", report.dialog()!);
  await report.click("Save Manual Match", report.dialog()!);
  assert.deepEqual(report.picked("TMDB shows"), []);
  assert.equal(report.heading(), "Manual Matches (2)");
  assert.equal(report.card("who").querySelector(".manual-match-saved")?.textContent, "Saved");
  assert.doesNotMatch(report.container.textContent!, /Hidden by the current filters/);
});

test("The show filters reset when the report is left or reloaded", async t => {
  const report = await mountReport(t, [...lostMatches(1), match("archer", [archer], [tvdbArcher])]);
  await report.pick("TMDB shows", "Lost (2004)");
  assert.equal(report.heading(), "Manual Matches (1 of 2)");
  // Leaving or reloading the page mounts a new report.
  await act(async () => report.root.render(createElement(ManualMatchEditor, { key: "reloaded", initialUrls: [], onChanged() {}, report: true })));
  assert.deepEqual(report.picked("TMDB shows"), []);
  assert.equal(report.heading(), "Manual Matches (2)");
});

test("A refresh that lands after the filters changed keeps the newer picks",async t => {
  const report = await mountReport(t, [match("who", [who], [tvdbWho]), match("archer", [archer], [tvdbArcher])]);
  await report.pick("TMDB shows", "Doctor Who (2005)");
  const release = report.holdRefresh();
  await deleteOne(report, "who");
  // The refresh is still pending while the picks change from Doctor Who to Archer.
  await report.pick("TMDB shows", "Archer (2009)");
  await report.click("Remove Doctor Who (2005)");
  assert.deepEqual(report.picked("TMDB shows"), ["Archer (2009)"]);
  await release();
  assert.deepEqual(report.deletes, [["who"]]);
  assert.deepEqual(report.picked("TMDB shows"), ["Archer (2009)"]);
  assert.equal(report.heading(), "Manual Matches (1 of 1)");
  assert.deepEqual(report.cards(), ["archer"]);
});

test("A save whose refresh lands after the filters changed is judged hidden against the newer picks", async t => {
  const report = await mountReport(t, [match("who", [who], [tvdbWho]), match("archer", [archer], [tvdbArcher])]);
  await report.pick("TMDB shows", "Doctor Who (2005)");
  report.server.resolveAs = [member("TMDB", { ...who, episode: 3 }), member("TVDB", { ...tvdbWho, episode: 3 })];
  await report.click(/^Edit/, report.card("who"));
  await report.click("Resolve and review", report.dialog()!);
  const release = report.holdRefresh();
  await report.click("Save Manual Match", report.dialog()!);
  // Saved under the Doctor Who pick, but Archer is picked instead before the refresh lands.
  await report.pick("TMDB shows", "Archer (2009)");
  await report.click("Remove Doctor Who (2005)");
  await release();
  assert.deepEqual(report.picked("TMDB shows"), ["Archer (2009)"]);
  assert.deepEqual(report.cards(), ["archer"]);
  assert.ok([...report.container.querySelectorAll('[role="status"]')].some(status => status.textContent === "Saved. Hidden by the current filters."));
});
