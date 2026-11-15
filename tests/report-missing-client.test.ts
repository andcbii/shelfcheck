import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ManualCoverageManager } from "../app/components/manual-coverage-manager";
import { ManualMatchEditor } from "../app/components/manual-match-editor";

const tmdb = { provider: "TMDB", id: 100, showId: 10, show: "Animaniacs", title: "Murder Pals", season: 3, episode: 18, url: "https://www.themoviedb.org/tv/10/season/3/episode/18", reportMissing: false };
const tvdb = { provider: "TVDB", id: 200, showId: 20, show: "Animaniacs", title: "Murder Pals (3)", season: 8, episode: 22, url: "https://thetvdb.com/series/animaniacs/episodes/200", reportMissing: false };

async function mount(t: test.TestContext, options: { members?: typeof tmdb[]; resolved?: typeof tmdb[]; scan?: () => string; dialog?: boolean } = {}) {
  const browser = new Window({ url: "http://localhost/plex" });
  let mapping = { id: "match", revision: 2, health: "healthy", members: options.members || [tmdb, tvdb] };
  const posts: Record<string, unknown>[] = [];
  const previous = new Map<string, PropertyDescriptor | undefined>();
  let dismissed = 0;
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch: async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/plex/scan") return Response.json({ scan: { status: options.scan?.() || "completed" } });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (body.action === "resolve") return Response.json({ preview: "reviewed", members: (options.resolved || mapping.members).map(member => ({ ...member, reportMissing: undefined })) });
      if (body.id && body.revision !== mapping.revision) return Response.json({ error: "This mapping changed since you opened it. Reopen it and review the latest records.", code: "stale-revision", mappingId: mapping.id }, { status: 409 });
      const flags = (body.reportMissing || []) as { provider: string; id: number }[];
      const members = body.preview ? options.resolved || mapping.members : mapping.members;
      mapping = { ...mapping, revision: mapping.revision + 1, members: members.map(member => ({ ...member, reportMissing: flags.some(flag => flag.provider === member.provider && flag.id === member.id) })) };
      return Response.json({ mapping, revision: mapping.revision, pending: 0 });
    }
    return Response.json({ mappings: [mapping], revision: mapping.revision, pending: 0 });
  } })) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () => root.render(options.dialog === false
    ? createElement(ManualMatchEditor, { initialUrls: [], onChanged() {}, report: true })
    : createElement(ManualCoverageManager, { initialUrls: [tvdb.url], onClose() { dismissed++; root.render(null); }, onChanged() {} }));
  t.after(async () => { await act(async () => root.unmount()); await browser.happyDOM.close(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  await act(async () => render());
  const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label);
  const click = async (label: string) => { const item = button(label); assert.ok(item, label); await act(async () => item.click()); };
  const editor = () => container.querySelector('[aria-label="Manual Match editor"]')!;
  const checkboxes = () => [...editor().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const toggle = async (index: number) => { const box = checkboxes()[index]; box.focus(); await act(async () => box.click()); };
  // Server-side Ignore cleanup: deletes saved flags and gives the mapping a new revision.
  const ignore = () => { mapping = { ...mapping, revision: mapping.revision + 1, members: mapping.members.map(member => ({ ...member, reportMissing: false })) }; };
  return { container, posts, ignore, last: () => posts.at(-1), render, button, click, editor, checkboxes, toggle, dismissed: () => dismissed };
}

test("each one-to-one episode has a keyboard-usable Report Missing checkbox in its provider panel", async t => {
  const ui = await mount(t);
  const editor = ui.editor();
  assert.deepEqual([...editor.querySelectorAll(".manual-match-panels > section header")].map(header => header.textContent), ["TMDB1 episode", "TVDB1 episode"]);
  const boxes = ui.checkboxes();
  assert.equal(boxes.length, 2);
  for (const [index, member] of [tmdb, tvdb].entries()) {
    const box = boxes[index];
    assert.equal(box.closest("label")?.textContent, "Report Missing", "Exact visible label");
    assert.equal(box.tabIndex, 0, "Native checkboxes stay in the keyboard order");
    const context = box.getAttribute("aria-describedby")!.split(" ").map(id => ui.container.querySelector(`[id="${id}"]`)?.textContent).join(" ");
    assert.match(context, new RegExp(`${member.provider}.*${member.title.replace(/[()]/g, "\\$&")}.*Episode ID ${member.id}`), "Each checkbox is associated with its episode");
    assert.equal(box.closest("section")?.querySelector("a")?.getAttribute("href"), member.url, "Provider links are preserved");
  }
  assert.match(editor.textContent || "", /S03E18.*S08E22/, "Each provider keeps its own numbering");
  assert.match(editor.textContent || "", /local Shelfcheck override/);
  assert.match(editor.textContent || "", /sends no report to Plex, TMDB, or TVDB/);
  await ui.toggle(1);
  assert.equal(ui.checkboxes()[1].checked, true);
  assert.equal(document.activeElement, ui.checkboxes()[1]);
});

test("Report Missing stays a draft until the Manual Match is saved, with a matching after-save preview", async t => {
  const ui = await mount(t);
  assert.match(ui.editor().textContent || "", /After saving.*every episode follows normal matching/i);
  await ui.toggle(1);
  assert.deepEqual(ui.posts, [], "Toggling saves nothing");
  assert.match(ui.editor().textContent || "", /After saving.*TVDB Murder Pals \(3\) stays missing as Reported missing/);
  assert.match(ui.editor().textContent || "", /Unsaved changes/);
  assert.doesNotMatch(ui.container.querySelector("article")?.textContent || "", /Reported missing/, "Saved rows show saved state, not the draft");
  await ui.click("Cancel");
  assert.equal(ui.checkboxes()[1].checked, false);
  assert.deepEqual(ui.posts, []);
  await ui.toggle(1);
  await ui.click("Save coverage mapping");
  assert.deepEqual(ui.posts, [{ action: "save", id: "match", revision: 2, reportMissing: [{ provider: "TVDB", id: 200 }] }]);
  assert.ok(ui.container.querySelector('[role="dialog"]'), "Saving keeps Matching Episodes open");
  assert.match(ui.container.querySelector("article")?.textContent || "", /Murder Pals \(3\).*Reported missing/);
  assert.equal(ui.checkboxes()[1].checked, true);
  assert.match(ui.editor().textContent || "", /No unsaved changes/);
  // Clearing is saved the same way.
  await ui.toggle(1);
  await ui.click("Save coverage mapping");
  assert.deepEqual(ui.last()?.reportMissing, []);
  assert.doesNotMatch(ui.container.querySelector("article")?.textContent || "", /Reported missing/);
});

test("resolved mapping edits carry the drafted flags with the reviewed preview", async t => {
  const ui = await mount(t);
  await ui.toggle(0);
  await ui.click("Resolve and review");
  assert.equal(ui.checkboxes()[0].checked, true, "Resolving keeps the draft");
  await ui.click("Save coverage mapping");
  assert.deepEqual(ui.posts.at(-1), { action: "save", preview: "reviewed", id: "match", revision: 2, reportMissing: [{ provider: "TMDB", id: 100 }] });
});

for (const dismissal of ["Close", "backdrop"]) {
  test(`Matching Episodes ${dismissal} discards unsaved Report Missing changes`, async t => {
    const ui = await mount(t);
    await ui.toggle(0);
    if (dismissal === "Close") await ui.click("Close");
    else await act(async () => ui.container.querySelector<HTMLElement>(".modal-backdrop")!.click());
    assert.equal(ui.dismissed(), 1);
    assert.deepEqual(ui.posts, []);
    await act(async () => ui.render());
    assert.equal(ui.checkboxes()[0].checked, false);
  });
}

// Two TMDB episodes and two TVDB episodes describe the same content; neither side is a combined episode.
const tmdbB = { ...tmdb, id: 101, title: "Other half", episode: 19, url: "https://www.themoviedb.org/tv/10/season/3/episode/19" };
const tvdbB = { ...tvdb, id: 201, title: "Murder Pals (2)", episode: 20, url: "https://thetvdb.com/series/animaniacs/episodes/201" };
const manyToMany = [tmdb, tmdbB, tvdb, tvdbB];
const repairHint = /at least one (TMDB|TVDB) episode.*or clear Report Missing on every episode/;

test("many-to-many drafts need an explicit Report Missing selection on both provider sides or none", async t => {
  const ui = await mount(t, { members: manyToMany });
  const save = () => ui.button("Save coverage mapping")!;
  const validation = () => ui.editor().querySelector(".report-missing-validation")?.textContent || "";
  assert.equal(ui.checkboxes().length, 4, "Every episode in either provider panel has Report Missing");
  assert.match(ui.editor().textContent || "", /After saving.*every episode follows normal matching/i, "Zero flags are valid");

  // A one-sided selection explains how to repair it and cannot be saved.
  await ui.toggle(2);
  assert.match(validation(), /at least one TMDB episode.*or clear Report Missing on every episode/);
  assert.equal(save().disabled, true);
  assert.ok(save().getAttribute("aria-describedby")?.split(" ").some(id => ui.container.querySelector(`[id="${id}"]`)?.textContent === validation()), "The disabled save is described by the validation message");
  assert.doesNotMatch(ui.editor().textContent || "", /Incomplete · mapped part missing/, "Nothing is derived for the opposite side");
  await ui.toggle(2);
  await ui.toggle(1);
  assert.match(validation(), /at least one TVDB episode/);
  assert.equal(save().disabled, true);

  // Flags on both sides are valid, previewed and saved as explicit selections only.
  await ui.toggle(3);
  assert.equal(validation(), "");
  assert.equal(save().disabled, false);
  assert.match(ui.editor().textContent || "", /After saving.*TMDB Other half, TVDB Murder Pals \(2\) stay missing as Reported missing in Plex results\. The other episodes follow normal matching\./);
  assert.doesNotMatch(ui.container.querySelector("article")?.textContent || "", /Reported missing/, "Saved rows show saved state, not the draft");
  await ui.click("Save coverage mapping");
  assert.deepEqual(ui.last(), { action: "save", id: "match", revision: 2, reportMissing: [{ provider: "TMDB", id: 101 }, { provider: "TVDB", id: 201 }] });
  const row = ui.container.querySelector("article")?.textContent || "";
  assert.equal(row.match(/Reported missing/g)?.length, 2);
  assert.doesNotMatch(row, /Incomplete/);
  assert.match(ui.editor().textContent || "", /No unsaved changes/);

  // Clearing every flag is valid too.
  await ui.toggle(1);
  assert.equal(save().disabled, true, "Clearing one side alone is one-sided");
  await ui.toggle(3);
  await ui.click("Save coverage mapping");
  assert.deepEqual(ui.last()?.reportMissing, []);
});

test("a membership edit that makes the draft many-to-many must repair its retained one-sided flags", async t => {
  const ui = await mount(t, { members: [tmdb, tvdb, { ...tvdbB, reportMissing: true }], resolved: manyToMany });
  assert.equal(ui.editor().querySelector(".report-missing-validation"), null, "The saved one-to-many flag is valid");
  // Re-resolving the edited membership reviews a second TMDB episode.
  await ui.click("Resolve and review");
  assert.equal(ui.checkboxes().length, 4);
  assert.match(ui.editor().querySelector(".report-missing-validation")?.textContent || "", /at least one TMDB episode/);
  assert.equal(ui.button("Save coverage mapping")?.disabled, true, "The retained flag alone cannot be saved with the new shape");
  await ui.toggle(1);
  await ui.click("Save coverage mapping");
  assert.deepEqual(ui.last(), { action: "save", preview: "reviewed", id: "match", revision: 2, reportMissing: [{ provider: "TMDB", id: 101 }, { provider: "TVDB", id: 201 }] });
});

test("a saved one-sided many-to-many state stays visible and the next save requires repair or clearing", async t => {
  // Automatic Ignore cleanup can leave flags on one side only.
  const ui = await mount(t, { members: [tmdb, tmdbB, tvdb, { ...tvdbB, reportMissing: true }] });
  assert.match(ui.container.querySelector("article")?.textContent || "", /Murder Pals \(2\).*Reported missing/, "The saved flag stays visible");
  assert.match(ui.editor().querySelector(".report-missing-validation")?.textContent || "", repairHint);
  await ui.toggle(3);
  assert.equal(ui.editor().querySelector(".report-missing-validation"), null);
  await ui.click("Save coverage mapping");
  assert.deepEqual(ui.last()?.reportMissing, []);
});

// The real example: TMDB "Murder Pals" is one combined episode; TVDB lists it as two parts.
const part2 = { ...tvdb, id: 199, title: "Murder Pals (2)", episode: 21, url: "https://thetvdb.com/series/animaniacs/episodes/199" };
const oneToMany = [tmdb, part2, tvdb];
// The same content with the provider roles reversed: TVDB lists one combined episode.
const reversed = [
  { ...tvdb, title: "Murder Pals (complete)" },
  { ...tmdb, id: 99, title: "Murder Pals, part 1", episode: 17, url: "https://www.themoviedb.org/tv/10/season/3/episode/17" },
  { ...tmdb, title: "Murder Pals, part 2" },
];

for (const [name, members, combined, part, otherPart] of [
  // [direction, members (combined first, flagged part last), combined label, flagged part label, unflagged part label]
  ["TMDB combined", oneToMany, "TMDB Murder Pals", "TVDB Murder Pals \\(3\\)", "TVDB Murder Pals \\(2\\)"],
  ["TVDB combined", reversed, "TVDB Murder Pals \\(complete\\)", "TMDB Murder Pals, part 2", "TMDB Murder Pals, part 1"],
] as const) {
  test(`${name}: one-to-many drafts preview the reported part and the incomplete combined episode`, async t => {
    const ui = await mount(t, { members: [...members] });
    assert.equal(ui.checkboxes().length, 3, "Every episode in either provider panel has Report Missing");
    const boxFor = (id: number) => ui.checkboxes().findIndex(box => box.getAttribute("aria-describedby")!.split(" ").some(ref => new RegExp(`Episode ID ${id}(?!\\d)`).test(ui.container.querySelector(`[id="${ref}"]`)?.textContent || "")));
    const flagged = members[2], whole = members[0];
    const partIndex = boxFor(flagged.id), wholeIndex = boxFor(whole.id);
    assert.ok(partIndex >= 0 && wholeIndex >= 0);
    await ui.toggle(partIndex);
    assert.deepEqual(ui.posts, [], "Toggling saves nothing");
    const draft = ui.editor().textContent || "";
    assert.match(draft, new RegExp(`After saving.*${part} stays missing as Reported missing.*${combined} stays missing as Incomplete · mapped part missing because it contains ${part}.*The other episode follows normal matching`));
    assert.match(draft, /Incomplete · mapped part missing/, "The combined episode's panel shows its derived draft status");
    assert.doesNotMatch(ui.container.querySelector("article")?.textContent || "", /Reported missing|Incomplete/, "Saved rows show saved state, not the draft");
    assert.equal(ui.checkboxes()[wholeIndex].checked, false, "The derived status is not a checkbox selection");

    await ui.click("Save coverage mapping");
    assert.deepEqual(ui.last(), { action: "save", id: "match", revision: 2, reportMissing: [{ provider: flagged.provider, id: flagged.id }] }, "Only the explicit flag is saved");
    const row = ui.container.querySelector("article")?.textContent || "";
    assert.match(row, new RegExp(`${part.replace(/^\w+ /, "")}.*Reported missing`));
    assert.match(row, new RegExp(`Incomplete · mapped part missing.*Contains ${part} \\(Episode ID ${flagged.id}\\), which you reported missing`), "The saved row names the flagged part responsible");
    assert.equal(row.match(/Incomplete · mapped part missing/g)?.length, 1, `Only the combined episode is derived missing, not ${otherPart}`);
    assert.equal(row.match(/Reported missing/g)?.length, 1);

    // An explicitly flagged combined episode infers nothing about its parts.
    await ui.toggle(partIndex);
    await ui.toggle(wholeIndex);
    assert.match(ui.editor().textContent || "", new RegExp(`After saving.*${combined} stays missing as Reported missing.*The other episodes follow normal matching`));
    assert.doesNotMatch(ui.editor().textContent || "", /Incomplete · mapped part missing/);
  });
}

test("Report Missing controls lock when a scan starts after the dialog opens", async t => {
  let status = "completed";
  const ui = await mount(t, { scan: () => status });
  assert.equal(ui.checkboxes()[0].disabled, false);
  await act(async () => { status = "running"; await new Promise(resolve => setTimeout(resolve, 1100)); });
  assert.ok(ui.checkboxes().every(box => box.disabled));
  assert.equal(ui.button("Save coverage mapping")?.disabled, true);
});

test("Manual Matches rows show saved Report Missing state in the same provider panels", async t => {
  const ui = await mount(t, { dialog: false, members: [tmdb, { ...tvdb, reportMissing: true }] });
  const row = ui.container.querySelector("article")!;
  assert.equal(row.querySelectorAll(".manual-match-panels > section").length, 2, "One row, both provider panels");
  assert.match(row.textContent || "", /Murder Pals \(3\).*Reported missing/);
  assert.equal(row.querySelectorAll('input[type="checkbox"]:not([aria-label^="Select mapping"])').length, 0, "Saved rows are not editors");
});

test("provider panels stack without clipping at narrow widths", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const rule = css.match(/\.manual-match-panels\s*\{[^}]*\}/)?.[0] || "";
  assert.match(rule, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*[^)]+\),\s*1fr\)\)/, "Panels wrap to one column inside narrow dialogs as well as narrow viewports");
  assert.match(css, /\.manual-match-panels\s*>\s*section\s*\{[^}]*min-width:\s*0/, "Panel content can shrink instead of overflowing");
});

test("Ignore applied while the editor is open rejects the stale draft and shows the refreshed saved state", async t => {
  const ui = await mount(t, { members: [tmdb, { ...tvdb, reportMissing: true }] });
  assert.match(ui.container.querySelector("article")?.textContent || "", /Reported missing/);
  await ui.toggle(0);
  ui.ignore();
  await ui.click("Save coverage mapping");
  assert.equal(ui.last()?.revision, 2, "The draft was opened at the pre-Ignore revision");
  assert.match(ui.container.textContent || "", /changed since you opened it/, "The stale draft is rejected with a clear message");
  assert.doesNotMatch(ui.container.querySelector("article")?.textContent || "", /Reported missing/, "Saved rows reload without the flag deleted by Ignore");
  assert.deepEqual(ui.checkboxes().map(box => box.checked), [false, false], "The editor reopens the refreshed saved state, discarding the stale draft");
  await ui.toggle(0);
  await ui.click("Save coverage mapping");
  assert.deepEqual(ui.last(), { action: "save", id: "match", revision: 3, reportMissing: [{ provider: "TMDB", id: 100 }] }, "The next save is based on the refreshed revision");
});
