import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { ManualCoverageManager } from "../app/components/manual-coverage-manager";
import { mountDom } from "./dom-environment";

test("Matching Episodes closes on Esc without saving and holds the page behind it still", async t => {
  const posts: unknown[] = [];
  const { container, root } = mountDom(t, { fetch: async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/plex/scan") return Response.json({ scan: { status: "completed" } });
    if (init?.method) posts.push(init.body);
    return Response.json({ mappings: [], revision: 0, pending: 0 });
  } });
  let dismissed = 0;
  await act(async () => root.render(createElement(ManualCoverageManager, { initialUrls: ["tvdb:999"], onClose() { dismissed++; root.render(null); }, onChanged() {} })));
  assert.equal(document.body.style.overflow, "hidden");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(dismissed, 1);
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(document.body.style.overflow, "");
  assert.deepEqual(posts, []);
});

test("Esc in a Delete confirmation over Matching Episodes closes only the confirmation", async t => {
  const member = (provider: "TMDB" | "TVDB", id: number) => ({ provider, id, showId: 1, show: "Animaniacs", title: "Murder Pals", season: 3, episode: 18, url: `${provider.toLowerCase()}:${id}` });
  const deletes: unknown[] = [];
  const { container, root } = mountDom(t, { fetch: async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/plex/scan") return Response.json({ scan: { status: "completed" } });
    if (init?.method === "DELETE") deletes.push(input);
    return Response.json({ mappings: [{ id: "murder-pals", revision: 1, health: "healthy", createdAt: "now", members: [member("TMDB", 4245050), member("TVDB", 9623972)] }], revision: 1, pending: 0 });
  } });
  let dismissed = 0;
  await act(async () => root.render(createElement(ManualCoverageManager, { initialUrls: ["tvdb:9623972"], onClose() { dismissed++; }, onChanged() {} })));
  const deleteButton = [...container.querySelectorAll("article button")].find(button => button.textContent === "Delete") as HTMLButtonElement | undefined;
  assert.ok(deleteButton, "the Manual Match card is shown in Matching Episodes");
  await act(async () => deleteButton.click());
  const dialogs = () => [...container.querySelectorAll('[role="dialog"]')].map(dialog => dialog.getAttribute("aria-label"));
  assert.deepEqual(dialogs(), ["Matching Episodes", "Delete Manual Match"]);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.deepEqual(dialogs(), ["Matching Episodes"]);
  assert.equal(dismissed, 0);
  assert.deepEqual(deletes, []);
});
