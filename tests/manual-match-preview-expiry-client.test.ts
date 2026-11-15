import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { ManualMatchEditor } from "../app/components/manual-match-editor";
import { mountDom } from "./dom-environment";

// The server keeps a reviewed preview for 30 minutes, then rejects Save and asks for a fresh Resolve.
test("after a preview expires, Resolve and review stays available and Save then uses the fresh preview", async t => {
  const members = [
    { provider: "TMDB", id: 100, showId: 10, show: "Target", title: "Pilot", season: 1, episode: 1, url: "https://example.com/100" },
    { provider: "TVDB", id: 200, showId: 20, show: "Other", title: "Pilot", season: 1, episode: 1, url: "https://example.com/200" },
  ];
  let resolves = 0;
  const saved: string[] = [];
  const { container, root } = mountDom(t, { fetch: async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "resolve") return Response.json({ preview: `preview-${++resolves}`, members });
      saved.push(body.preview);
      if (body.preview === "preview-1") return Response.json({ error: "The preview expired. Resolve the episode inputs again." }, { status: 400 });
      return Response.json({ revision: 2 });
    }
    return Response.json({ revision: 1, mappings: [], pending: 0 });
  } });
  await act(async () => root.render(createElement(ManualMatchEditor, { initialUrls: ["tmdb:100 show:10 season:1 episode:1", "tvdb:200"], onChanged() {} })));
  const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label);
  const click = async (label: string) => { const item = button(label); assert.ok(item, `${label} is shown`); await act(async () => item.click()); };

  await click("Resolve and review");
  await click("Save Manual Match");
  assert.match(container.textContent || "", /The preview expired\. Resolve the episode inputs again\./);
  assert.ok(button("Resolve and review"), "the recovery the error asks for is offered without changing the inputs");

  await click("Resolve and review");
  await click("Save Manual Match");
  assert.deepEqual(saved, ["preview-1", "preview-2"], "Save sends the fresh preview, not the expired one");
});
