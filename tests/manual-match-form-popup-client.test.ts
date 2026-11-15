import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { ManualMatchEditor } from "../app/components/manual-match-editor";
import { mountDom } from "./dom-environment";

const tmdb = { provider: "TMDB", id: 4245050, showId: 107124, show: "Animaniacs", title: "Murder Pals", season: 3, episode: 18, url: "https://www.themoviedb.org/tv/107124/season/3/episode/18" };
const tvdb = { provider: "TVDB", id: 9623973, showId: 386114, show: "Animaniacs", title: "Murder Pals (3)", season: 8, episode: 22, url: "https://thetvdb.com/series/animaniacs/episodes/9623973" };

// The Manual Matches page with one saved Manual Match. A Plex scan runs while scan.running is set,
// and saves wait for saveGate when one is given.
async function mountPage(t: test.TestContext, { saveError, scan = { running: false }, saveGate }: { saveError?: string; scan?: { running: boolean }; saveGate?: Promise<void> } = {}) {
  let mapping = { id: "animaniacs-match", revision: 7, health: "healthy", members: [tmdb, tvdb] };
  const posts: Record<string, unknown>[] = [];
  const { browser, container, root } = mountDom(t, { fetch: async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/plex/scan") return Response.json({ scan: { status: scan.running ? "running" : "completed" } });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (body.action === "resolve") return Response.json({ preview: "reviewed", members: [tmdb, tvdb] });
      await saveGate;
      if (saveError) return Response.json({ error: saveError }, { status: 400 });
      mapping = { ...mapping, revision: mapping.revision + 1 };
      return Response.json({ mapping, revision: mapping.revision, pending: 0 });
    }
    return Response.json({ mappings: [mapping], revision: mapping.revision, pending: 0 });
  } });
  await act(async () => root.render(createElement(ManualMatchEditor, { initialUrls: [], onChanged() {}, report: true })));
  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');
  const buttons = (scope: ParentNode = container) => [...scope.querySelectorAll("button")];
  const click = async (label: string | RegExp, scope: ParentNode = container) => {
    const button = buttons(scope).find(item => typeof label === "string" ? item.textContent === label || item.getAttribute("aria-label") === label : label.test(item.textContent || ""));
    assert.ok(button, String(label));
    await act(async () => button.click());
  };
  // react-dom loads before the DOM globals exist, so it detects no "input" event and
  // falls back to watching the focused field's value on keyup.
  const type = async (input: HTMLInputElement, value: string) => act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new browser.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
  const episodeInputs = () => [...dialog()!.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')];
  return { container, posts, dialog, buttons, click, type, episodeInputs };
}

test("+ Add Manual Match opens the whole editor in a popup, leaving nothing at the top of the page", async t => {
  const page = await mountPage(t);
  assert.equal(page.dialog(), null);
  await page.click("+ Add Manual Match");
  const dialog = page.dialog();
  assert.ok(dialog, "The editor opens in a popup");
  assert.equal(dialog.getAttribute("aria-label"), "Add Manual Match");
  assert.equal(page.container.querySelectorAll('[aria-label="Manual Match editor"]').length, 1);
  assert.ok(dialog.querySelector('[aria-label="Manual Match editor"]'), "The editor form is inside the popup");
  assert.deepEqual(page.episodeInputs().map(input => input.closest("label")?.textContent), ["Episode 1", "Episode 2"]);
  assert.match(dialog.textContent || "", /Add each episode's TMDB or TVDB link \(or an ID like tvdb:200\) in any order\. Each side needs at least one episode\./);
  assert.ok(page.buttons(dialog).some(button => button.textContent === "Resolve and review"));
  assert.ok(page.buttons(dialog).some(button => button.textContent === "Cancel"));
  await page.click("+ Add episode", dialog);
  assert.deepEqual(page.episodeInputs().map(input => input.closest("label")?.textContent), ["Episode 1", "Episode 2", "Episode 3"]);
});

test("Edit opens the saved Manual Match in a popup titled by show and episode, without its ID or revision", async t => {
  const page = await mountPage(t);
  await page.click(/^Edit/, page.container.querySelector("article")!);
  const dialog = page.dialog();
  assert.ok(dialog, "Edit opens the popup");
  assert.equal(dialog.getAttribute("aria-label"), "Edit Manual Match · Animaniacs · Murder Pals");
  assert.equal(dialog.querySelector("h2")?.textContent, "Edit Manual Match · Animaniacs · Murder Pals");
  assert.doesNotMatch(dialog.textContent || "", /animaniacs-match|Revision/);
  assert.deepEqual(page.episodeInputs().map(input => input.value), [tmdb.url, tvdb.url]);
  // The saved episodes are already reviewed: TMDB beside TVDB, each with Report missing.
  assert.deepEqual([...dialog.querySelectorAll(".manual-match-panels > section .provider-badge")].map(badge => badge.textContent), ["TMDB", "TVDB"]);
  assert.equal(dialog.querySelectorAll('.manual-match-panels input[type="checkbox"]').length, 2);
});

test("resolving inside the popup reviews the episodes side by side before saving", async t => {
  const page = await mountPage(t);
  await page.click("+ Add Manual Match");
  const [first, second] = page.episodeInputs();
  await page.type(first, tmdb.url);
  await page.type(second, tvdb.url);
  assert.ok(!page.buttons(page.dialog()!).some(button => button.textContent === "Save Manual Match"), "Save appears once the episodes are reviewed");
  await page.click("Resolve and review", page.dialog()!);
  assert.deepEqual(page.posts.at(-1), { action: "resolve", urls: [tmdb.url, tvdb.url] });
  const dialog = page.dialog()!;
  assert.ok(dialog, "Resolving keeps the popup open");
  const panels = [...dialog.querySelectorAll(".manual-match-panels > section")];
  assert.deepEqual(panels.map(panel => panel.querySelector(".provider-badge")?.textContent), ["TMDB", "TVDB"]);
  assert.ok(panels.every(panel => panel.querySelectorAll('input[type="checkbox"]').length === 1), "Each resolved episode has a Report missing checkbox");
  assert.equal(dialog.querySelector(".manual-match-review-divider")?.textContent, "Review", "A Review divider leads into the resolved episodes");
  assert.equal(dialog.querySelector(".manual-match-draft-state")?.textContent, "● Unsaved changes");
  assert.match(dialog.textContent || "", /Report Missing keeps an episode missing in your Plex results when your copy lacks its content\. It stays in Shelfcheck and is never sent to Plex, TMDB or TVDB\./);
});

test("Save closes the popup, and the edited card shows a brief Saved note in its header row", async t => {
  const page = await mountPage(t);
  await page.click(/^Edit/, page.container.querySelector("article")!);
  await page.click("Resolve and review", page.dialog()!);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await page.click("Save Manual Match", page.dialog()!);
  assert.equal(page.posts.at(-1)?.action, "save");
  assert.ok(!page.dialog(), "Saving closes the popup");
  const header = page.container.querySelector("article header")!;
  assert.equal(header.querySelector(".manual-match-saved")?.textContent, "Saved", "The edited card says Saved in its header row");
  assert.doesNotMatch(page.container.textContent || "", /Saved\. /, "The card's note replaces the long saved message");
  await act(async () => t.mock.timers.tick(5000));
  assert.ok(!page.container.querySelector(".manual-match-saved"), "The Saved note is brief");
});

test("a failed save keeps the popup open and shows the error inside it", async t => {
  const page = await mountPage(t, { saveError: "Each side needs at least one episode." });
  await page.click(/^Edit/, page.container.querySelector("article")!);
  await page.click("Resolve and review", page.dialog()!);
  await page.click("Save Manual Match", page.dialog()!);
  assert.equal(page.posts.at(-1)?.action, "save");
  assert.equal(page.dialog()?.querySelector('[role="alert"]')?.textContent, "Each side needs at least one episode.");
  assert.equal(page.container.querySelectorAll('[role="alert"]').length, 1, "The error is shown only inside the popup");
});

test("closing the popup returns to the Edit button the user opened it from", async t => {
  const page = await mountPage(t);
  const edit = page.buttons(page.container.querySelector("article")!).find(button => /^Edit/.test(button.textContent || ""))!;
  edit.focus();
  await act(async () => edit.click());
  assert.ok(page.dialog()?.contains(document.activeElement), "Focus moves into the popup");
  await page.click("Cancel", page.dialog()!);
  assert.equal(page.dialog(), null);
  assert.equal(document.activeElement, edit, "The user is back on the card they edited");
});

test("Close, Cancel and Esc close the popup without saving", async t => {
  const page = await mountPage(t);
  await page.click("+ Add Manual Match");
  await page.click("Close Add Manual Match");
  assert.equal(page.dialog(), null);
  await page.click(/^Edit/, page.container.querySelector("article")!);
  await page.click("Cancel", page.dialog()!);
  assert.equal(page.dialog(), null);
  await page.click("+ Add Manual Match");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(page.dialog(), null);
  assert.deepEqual(page.posts, []);
  assert.equal(document.body.style.overflow, "", "The page scrolls again once the popup closes");
});

// Changes the saved Manual Match's first episode in the open editor popup.
async function editFirstEpisode(page: Awaited<ReturnType<typeof mountPage>>) {
  await page.click(/^Edit/, page.container.querySelector("article")!);
  await page.type(page.episodeInputs()[0], "tmdb:1 show:2 season:3 episode:4");
}
const prompt = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Discard your changes?"]');

test("closing with unsaved changes asks Discard your changes?, and Keep editing returns to the draft", async t => {
  const page = await mountPage(t);
  await editFirstEpisode(page);
  await page.click("Close Edit Manual Match · Animaniacs · Murder Pals");
  const asked = prompt();
  assert.ok(asked, "Close asks before throwing the changes away");
  assert.equal(asked.querySelector("h2")?.textContent, "Discard your changes?");
  assert.deepEqual(page.buttons(asked).filter(button => !button.getAttribute("aria-label")).map(button => button.textContent), ["Keep editing", "Discard changes"]);
  await page.click("Keep editing", asked);
  assert.ok(!prompt(), "Keep editing dismisses the question");
  assert.equal(page.episodeInputs()[0].value, "tmdb:1 show:2 season:3 episode:4", "The draft is untouched");
  assert.ok(page.dialog()?.contains(document.activeElement), "Focus is back in the editor");
});

test("Discard changes closes the editor popup without saving", async t => {
  const page = await mountPage(t);
  await editFirstEpisode(page);
  await page.click("Cancel", page.dialog()!);
  await page.click("Discard changes", prompt()!);
  assert.ok(!prompt());
  assert.ok(!page.dialog(), "The editor popup closes");
  assert.deepEqual(page.posts, []);
  await page.click(/^Edit/, page.container.querySelector("article")!);
  assert.equal(page.episodeInputs()[0].value, tmdb.url, "Reopening starts from the saved Manual Match");
});

test("Esc and a click outside ask too, and Esc on the question keeps editing", async t => {
  const page = await mountPage(t);
  await editFirstEpisode(page);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.ok(prompt(), "Esc asks");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.ok(!prompt(), "Esc on the question keeps editing");
  assert.ok(page.dialog(), "The editor stays open");
  await act(async () => page.dialog()!.parentElement!.click());
  assert.ok(prompt(), "A click outside asks");
  assert.ok(page.dialog(), "The editor stays open behind the question");
});

// The page polls the scan status every second.
const nextScanPoll = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });

test("a scan that starts mid-edit keeps the draft and pauses saving until it ends", async t => {
  const scan = { running: false };
  const page = await mountPage(t, { scan });
  await editFirstEpisode(page);
  await page.click("Resolve and review", page.dialog()!);
  const save = () => page.buttons(page.dialog()!).find(button => button.textContent === "Save Manual Match")!;
  assert.equal(save().disabled, false);
  scan.running = true;
  await nextScanPoll();
  const dialog = page.dialog()!;
  assert.ok(dialog, "The popup stays open");
  assert.match(dialog.querySelector('[role="status"].manual-match-scan-paused')?.textContent || "", /A Plex scan is running\. Saving is paused until it finishes\. Your changes are kept\./);
  assert.equal(save().disabled, true, "Save waits for the scan");
  assert.equal(page.episodeInputs()[0].value, "tmdb:1 show:2 season:3 episode:4", "The draft is kept");
  assert.equal(dialog.querySelector(".manual-match-draft-state")?.textContent, "● Unsaved changes");
  assert.ok(page.episodeInputs().every(input => !input.disabled), "Editing carries on during the scan");
  await page.click("Save Manual Match", dialog);
  assert.ok(!page.posts.some(post => post.action === "save"), "Nothing is saved during the scan");
  scan.running = false;
  await nextScanPoll();
  assert.ok(!page.dialog()!.querySelector(".manual-match-scan-paused"), "The notice goes when the scan ends");
  assert.equal(save().disabled, false, "Save works again");
  await page.click("Save Manual Match", page.dialog()!);
  assert.equal(page.posts.at(-1)?.action, "save");
  assert.ok(!page.dialog(), "The save goes through and closes the popup");
});

test("while a save is in flight, Close and Esc wait for it instead of offering to discard what is being saved", async t => {
  let release = () => {};
  const page = await mountPage(t, { saveGate: new Promise<void>(resolve => { release = resolve; }) });
  await editFirstEpisode(page);
  await page.click("Resolve and review", page.dialog()!);
  await page.click("Save Manual Match", page.dialog()!);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await page.click("Close Edit Manual Match · Animaniacs · Murder Pals");
  assert.ok(!prompt(), "Nothing offers to discard changes that are being saved");
  assert.ok(page.dialog(), "The popup waits for the save");
  await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.ok(!page.dialog(), "The save closes the popup");
  assert.equal(page.container.querySelector("article .manual-match-saved")?.textContent, "Saved");
});

test("saving the same Manual Match again restarts its Saved note", async t => {
  const page = await mountPage(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const episode of ["tmdb:1 show:2 season:3 episode:4", "tmdb:5 show:6 season:7 episode:8"]) {
    await page.click(/^Edit/, page.container.querySelector("article")!);
    await page.type(page.episodeInputs()[0], episode);
    await page.click("Resolve and review", page.dialog()!);
    await page.click("Save Manual Match", page.dialog()!);
    await act(async () => t.mock.timers.tick(3000));
  }
  assert.ok(page.container.querySelector("article .manual-match-saved"), "The second save's note runs its full time");
});
