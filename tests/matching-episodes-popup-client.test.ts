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
