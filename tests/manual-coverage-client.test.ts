import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ManualCoverageManager } from "../app/components/manual-coverage-manager";
test("manual coverage manager presents reviewed identities and deletes the selected mapping", async (t) => {
  const browser = new Window({ url: "http://localhost/plex" });
  const old = new Map<string, PropertyDescriptor | undefined>();
  const members = [{ provider: "TMDB", id: 100, show: "Target", title: "Missing", season: 1, episode: 1, url: "https://example.com/100" }, { provider: "TVDB", id: 200, show: "Other", title: "Equivalent", season: 8, episode: 8, url: "https://example.com/200" }];
  let deleted = "";
  let changed = 0;
  let savedPreview = "";
  let savedId = "";
  let savedRevision = 0;
  let rejectEdit = false;
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch: async (input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.action === "resolve")
          return Response.json({ preview: "reviewed", members });
        if (rejectEdit) return Response.json({ error: "This mapping changed. Reopen it.", code: "stale-revision", mappingId: "saved" }, { status: 409 });
        savedPreview = body.preview;
        savedId = body.id;
        savedRevision = body.revision;
        return Response.json({ revision: 3 });
      }
      if (init?.method === "DELETE") {
        deleted = String(input);
        return Response.json({ revision: 2 });
      }
      return Response.json({ mappings: [{ id: "saved", revision: 1, members }], pending: 0 });
    } })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [key, value] of old) {
      if (value)
        Object.defineProperty(globalThis, key, value);
      else
        Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(createElement(ManualCoverageManager, { initialUrls: ["https://www.themoviedb.org/tv/10/season/1/episode/1", "https://thetvdb.com/series/other/episodes/200"], onClose: () => {
    }, onChanged: () => {
      changed++;
    } })));
  assert.match(container.textContent || "", /Target/);
  assert.match(container.textContent || "", /Other/);
  assert.match(container.textContent || "", /200/);
  const edit = [...container.querySelectorAll("button")].find(b => b.textContent === "Edit mapping");
  assert.ok(edit);
  await act(async () => edit.click());
  assert.match(container.textContent || "", /Editing mapping/);
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Delete mapping");
  assert.ok(button);
  await act(async () => button.click());
  assert.equal(deleted, "/api/plex/manual-coverage?id=saved");
  assert.equal(changed, 1);
  assert.ok(![...container.querySelectorAll("button")].some(button => button.textContent === "Save coverage mapping"));
  const resolve = [...container.querySelectorAll("button")].find(button => button.textContent === "Resolve and review");
  assert.ok(resolve);
  const reopen = [...container.querySelectorAll("button")].find(b => b.textContent === "Edit mapping");
  assert.ok(reopen);
  await act(async () => reopen.click());
  await act(async () => resolve.click());
  const preview = container.querySelector('[aria-label="Resolved episode preview"]');
  assert.ok(preview);
  assert.match(preview.textContent || "", /Episode ID 100/);
  assert.match(preview.textContent || "", /S8 E8/);
  const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Save coverage mapping");
  assert.ok(save);
  rejectEdit = true;
  await act(async () => save.click());
  assert.match(container.querySelector('[role="alert"]')?.textContent || "", /This mapping changed/);
  assert.ok(container.querySelector('[aria-label="Resolved episode preview"]'));
  assert.equal(changed, 1);
  rejectEdit = false;
  await act(async () => save.click());
  assert.equal(savedPreview, "reviewed");
  assert.equal(savedId, "saved");
  assert.equal(savedRevision, 1);
  assert.equal(changed, 2);
});


test("selecting an existing member opens its mapping for editing instead of offering a competing save", async (t) => {
  const browser = new Window({ url: "http://localhost/plex" });
  const old = new Map<string, PropertyDescriptor | undefined>();
  const members = [{ provider: "TMDB", id: 100, show: "Target", title: "Missing", season: 1, episode: 1, url: "https://example.com/100" }, { provider: "TVDB", id: 200, show: "Other", title: "Equivalent", season: 8, episode: 8, url: "https://example.com/200" }];
  const mapping = { id: "existing", revision: 4, members };
  let saves = 0;
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch: async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "resolve") return Response.json({ preview: "reviewed", members, existingMapping: mapping });
      saves++;
    }
    return Response.json({ mappings: [mapping], pending: 0 });
  } })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [key, value] of old) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(createElement(ManualCoverageManager, { initialUrls: ["https://www.themoviedb.org/tv/10/season/1/episode/1", "https://thetvdb.com/series/other/episodes/200"], onClose() {}, onChanged() {} })));
  const resolve = [...container.querySelectorAll("button")].find(button => button.textContent === "Resolve and review");
  assert.ok(resolve);
  await act(async () => resolve.click());
  assert.match(container.textContent || "", /Editing mapping existing · Revision 4/);
  assert.equal(container.querySelector('[aria-label="Episode URL 1"]')?.getAttribute("value"), "https://example.com/100");
  assert.equal(container.querySelector('[aria-label="Resolved episode preview"]'), null);
  assert.equal(saves, 0);
});
