import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { ManualMatchEditor } from "../app/components/manual-match-editor";
import { ManualMatchList } from "../app/components/manual-match-list";
import type { CoverageMapping } from "../lib/manual-coverage-model";
import { mountDom } from "./dom-environment";

const member = (provider: "TMDB" | "TVDB", id: number, title: string, episode: number) => ({ provider, id, showId: provider === "TMDB" ? 107124 : 72879, show: "Animaniacs", title, season: 3, episode, url: `https://example.com/${id}` });
const murderPals: CoverageMapping = { id: "murder-pals", revision: 1, health: "healthy", createdAt: "now", members: [member("TMDB", 4245050, "Murder Pals", 18), member("TVDB", 9623972, "Murder Pals (2)", 20), member("TVDB", 9623973, "Murder Pals (3)", 22)] };
const hooray: CoverageMapping = { id: "hooray", revision: 1, health: "healthy", createdAt: "now", members: [member("TMDB", 4245001, "Hooray for North Hollywood", 1), member("TVDB", 9623001, "Hooray for North Hollywood (1)", 1)] };

// The Manual Matches page over a stubbed API that records each DELETE request.
async function mountPage(t: test.TestContext) {
  let mappings = [murderPals, hooray];
  let revision = 1;
  const deletes: string[] = [];
  const { container, root } = mountDom(t, { fetch: async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/plex/scan") return Response.json({ scan: { status: "completed" } });
    if (init?.method === "DELETE") {
      const ids: string[] = init.body ? JSON.parse(String(init.body)).ids : [new URL(String(input), "http://localhost").searchParams.get("id")!];
      deletes.push(ids.join());
      mappings = mappings.filter(mapping => !ids.includes(mapping.id));
      return Response.json({ deleted: ids, missing: [], revision: ++revision });
    }
    return Response.json({ mappings, revision, pending: 0 });
  } });
  await act(async () => root.render(createElement(ManualMatchEditor, { initialUrls: [], report: true, onChanged() {} })));
  const buttonIn = (scope: ParentNode, label: string | RegExp) => {
    const button = [...scope.querySelectorAll("button")].find(b => typeof label === "string" ? b.textContent === label : label.test(b.textContent || ""));
    assert.ok(button, `button ${label}`);
    return button;
  };
  const click = async (scope: ParentNode, label: string | RegExp) => { const button = buttonIn(scope, label); await act(async () => button.click()); };
  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');
  const card = (title: string) => [...container.querySelectorAll("article")].find(article => article.textContent?.includes(title))!;
  const tick = async (title: string) => { const box = card(title).querySelector<HTMLInputElement>('input[type="checkbox"]')!; await act(async () => box.click()); };
  const bulkBar = () => container.querySelector('[aria-label="Selected Manual Matches"]');
  return { container, deletes, buttonIn, click, dialog, card, tick, bulkBar };
}

test("deleting one Manual Match asks first, and Cancel deletes nothing", async t => {
  const { deletes, click, dialog, card } = await mountPage(t);
  await click(card("Murder Pals"), /^Delete/);
  assert.equal(dialog()?.getAttribute("aria-label"), "Delete Manual Match");
  assert.match(dialog()?.textContent || "", /Delete this match\?/);
  assert.match(dialog()?.textContent || "", /Animaniacs · Murder Pals \(1 TMDB episode, 2 TVDB episodes\)/);
  assert.match(dialog()?.textContent || "", /This can’t be undone/);
  await click(dialog()!, "Cancel");
  assert.equal(dialog(), null);
  assert.deepEqual(deletes, []);
  assert.ok(card("Murder Pals"));
});

for (const [way, dismiss] of [
  ["Close", (dialog: HTMLElement) => act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Close Delete Manual Match"]')!.click())],
  ["Esc", () => act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); })],
  ["a click outside", (dialog: HTMLElement) => act(async () => (dialog.parentElement as HTMLElement).click())],
] as const) {
  test(`dismissing the single delete confirmation with ${way} deletes nothing`, async t => {
    const { deletes, click, dialog, card } = await mountPage(t);
    await click(card("Murder Pals"), /^Delete/);
    assert.equal(dialog()?.getAttribute("aria-label"), "Delete Manual Match");
    await dismiss(dialog()!);
    assert.equal(dialog(), null);
    assert.deepEqual(deletes, []);
    assert.ok(card("Murder Pals"));
  });
}

test("confirming the single delete removes only that Manual Match", async t => {
  const { container, deletes, click, dialog, card } = await mountPage(t);
  await click(card("Hooray"), /^Delete/);
  assert.match(dialog()?.textContent || "", /Animaniacs · Hooray for North Hollywood \(1 TMDB episode, 1 TVDB episode\)/);
  await click(dialog()!, "Delete match");
  assert.equal(dialog(), null);
  assert.deepEqual(deletes, ["hooray"]);
  assert.equal(container.querySelectorAll("article").length, 1);
});

test("the bulk bar appears only while a card is ticked", async t => {
  const { buttonIn, bulkBar, tick } = await mountPage(t);
  assert.equal(bulkBar(), null);
  await tick("Murder Pals");
  assert.match(bulkBar()?.textContent || "", /1 selected/);
  assert.ok(buttonIn(bulkBar()!, "Delete 1 selected match"));
  await tick("Hooray");
  assert.ok(buttonIn(bulkBar()!, "Delete 2 selected matches"));
  await tick("Murder Pals");
  await tick("Hooray");
  assert.equal(bulkBar(), null);
});

test("bulk delete confirms in the same popup style; Cancel deletes nothing and Delete removes the ticked matches", async t => {
  const { container, deletes, click, dialog, bulkBar, tick } = await mountPage(t);
  await tick("Murder Pals");
  await tick("Hooray");
  await click(bulkBar()!, "Delete 2 selected matches");
  assert.equal(dialog()?.getAttribute("aria-label"), "Delete Manual Matches");
  assert.match(dialog()?.textContent || "", /Delete 2 matches\?/);
  assert.match(dialog()?.textContent || "", /Animaniacs · Murder Pals/);
  assert.match(dialog()?.textContent || "", /Animaniacs · Hooray for North Hollywood/);
  await click(dialog()!, "Cancel");
  assert.equal(dialog(), null);
  assert.deepEqual(deletes, []);
  assert.match(bulkBar()?.textContent || "", /2 selected/, "Cancel keeps the selection");
  await click(bulkBar()!, "Delete 2 selected matches");
  await click(dialog()!, "Delete 2 matches");
  assert.equal(dialog(), null);
  assert.deepEqual(deletes, ["murder-pals,hooray"]);
  assert.equal(container.querySelectorAll("article").length, 0);
  assert.equal(bulkBar(), null);
});

// The Manual Match list alone, so a test can refresh its matches while a confirmation is open.
function mountList(t: test.TestContext) {
  const { container, root } = mountDom(t);
  const render = (matches: CoverageMapping[], confirmation: string[] | null = null) => act(async () => root.render(createElement(ManualMatchList, {
    matches, report: true, filterSelectAndPage: true, locked: false, pending: false, healthFilter: "all", onHealthFilterChange() {},
    paging: { page: 1, pageSize: 10, onPageChange() {}, onPageSizeChange() {} },
    selection: { selected: confirmation || [], onSelectionChange() {}, confirmation, onConfirmationChange() {} },
    onDeleteSelected() {}, onEdit() {}, onDelete() {},
  })));
  // The open confirmation's text, or null; a failing assertion then prints text, not a whole DOM node.
  const dialogText = () => container.querySelector('[role="dialog"]')?.textContent ?? null;
  const deleteButton = (title: string) => [...container.querySelectorAll("article")].find(article => article.textContent?.includes(title))!.querySelector<HTMLButtonElement>("button:last-child")!;
  return { render, dialogText, deleteButton };
}

test("a refresh that removes the Manual Match awaiting a single delete closes its confirmation for good", async t => {
  const { render, dialogText, deleteButton } = mountList(t);
  await render([murderPals, hooray]);
  await act(async () => deleteButton("Hooray").click());
  assert.match(dialogText() || "", /Hooray for North Hollywood/);
  await render([murderPals]);
  assert.equal(dialogText(), null);
  await render([murderPals, hooray]);
  assert.equal(dialogText(), null, "the confirmation does not come back with the Manual Match");
});

test("a refresh that removes any Manual Match awaiting a bulk delete hides the confirmation rather than shrinking it", async t => {
  const { render, dialogText } = mountList(t);
  await render([murderPals, hooray], ["murder-pals", "hooray"]);
  assert.match(dialogText() || "", /Delete 2 matches\?/);
  await render([murderPals], ["murder-pals", "hooray"]);
  assert.equal(dialogText(), null, "no shrunken confirmation");
});
