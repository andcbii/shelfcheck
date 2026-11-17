import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { mountDom } from "./dom-environment";
import { MultipleProviderIdReport } from "../app/reports/components/multiple-provider-id-report";
import { multipleProviderIdEntries } from "../lib/multiple-provider-ids-report";
import { multipleProviderIdsHref } from "../lib/multiple-provider-ids-link";
import type { ProviderCatalogueSelection, ShowCatalogueSelection } from "../lib/catalogue-selection-store";

const single = (id: number): ProviderCatalogueSelection => ({ candidates: [{ id, name: `TVDB ${id}` }], automaticId: id, preferredId: id, current: { preferredId: id, usingId: id, state: "preferred", selectedAt: "2026-01-01T00:00:00Z" } });
const selection = (override?: number): ShowCatalogueSelection => ({
  tmdb: { candidates: [{ id: 2150, name: "Dynomutt Hour" }, { id: 337142, name: "The Scooby-Doo Show" }], automaticId: 2150, preferredId: override ?? 2150, ...(override ? { override } : {}),
    current: { preferredId: override ?? 2150, usingId: override ?? 2150, state: "preferred", selectedAt: "2026-01-01T00:00:00Z" } },
  tvdb: single(73817),
});
const entries = (count = 1, override?: number) => multipleProviderIdEntries({
  selections: Object.fromEntries(Array.from({ length: count }, (_, n) => [n ? `ratingKey:${n}` : "plex://show/scooby", selection(override)])),
  shows: Array.from({ length: count }, (_, n) => ({ ratingKey: n ? `ratingKey:${n}` : "plex://show/scooby", title: n ? `Show ${String(n).padStart(2, "0")}` : "Zz Scooby", year: 1976 })),
  issues: [],
});
type Call = { url: string; body?: unknown };
function fetcher(calls: Call[], respond: (body: Record<string, unknown>) => Response, scanning = () => false) {
  return async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url === "/api/plex/scan") return Response.json({ scan: { status: scanning() ? "running" : "completed" } });
    const body = JSON.parse(init?.body || "{}");
    calls.push({ url, body });
    return respond(body);
  };
}
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text) as HTMLButtonElement;

test("each show is a group with TMDB and TVDB panels, radios only where Plex reports several IDs", async t => {
  const { container, root } = mountDom(t, { fetch: fetcher([], () => Response.json({})) });
  await act(async () => root.render(createElement(MultipleProviderIdReport, { entries: entries(), initialScanning: false, onChanged() {} })));
  const article = container.querySelector("article")!;
  assert.equal(`/reports/multiple-provider-ids#${article.id}`, multipleProviderIdsHref("plex://show/scooby"), "the entry's anchor matches the shared link");
  assert.match(article.querySelector("h2")?.textContent || "", /Zz Scooby1976/);
  const panels = article.querySelectorAll(".show-provider-matches");
  assert.equal(panels.length, 2);
  assert.match(panels[0].textContent || "", /TMDB2 IDs/);
  assert.equal(panels[0].querySelectorAll('input[type="radio"]').length, 2);
  assert.equal((panels[0].querySelector('input[value="2150"]') as HTMLInputElement).checked, true);
  assert.match(panels[0].textContent || "", /Dynomutt Hour.*2150.*Automatic/);
  assert.equal(panels[0].querySelector('a[href="https://www.themoviedb.org/tv/337142"]') !== null, true);
  assert.equal(panels[1].querySelectorAll('input[type="radio"]').length, 0, "a single-ID provider has no control");
  assert.match(panels[1].textContent || "", /73817.*Automatic selection/);
  assert.match(article.textContent || "", /Currently using.*Dynomutt Hour \(2150\)/);
  assert.match(article.textContent || "", /Preference.*Automatic: Dynomutt Hour \(2150\), the lowest ID/);
  assert.equal(button(container, "Use automatic").disabled, true, "nothing to clear");
});

test("the report stays available with an empty state", async t => {
  const { container, root } = mountDom(t, { fetch: fetcher([], () => Response.json({})) });
  await act(async () => root.render(createElement(MultipleProviderIdReport, { entries: [], initialScanning: false, onChanged() {} })));
  assert.match(container.textContent || "", /No shows with multiple provider IDs/);
});

test("Save override posts the chosen candidate, reports success and refreshes the report", async t => {
  const calls: Call[] = [];
  let refreshed = 0;
  const { container, root } = mountDom(t, { fetch: fetcher(calls, () => Response.json({ selection: selection(337142) })) });
  await act(async () => root.render(createElement(MultipleProviderIdReport, { entries: entries(), initialScanning: false, onChanged() { refreshed += 1; } })));
  await act(async () => (container.querySelector('input[value="337142"]') as HTMLInputElement).click());
  await act(async () => button(container, "Save override").click());
  assert.deepEqual(calls, [{ url: "/api/plex/catalogue-selection", body: { identity: "plex://show/scooby", provider: "tmdb", seriesId: 337142 } }]);
  assert.match(container.textContent || "", /Override saved; the show was rechecked from saved data/);
  assert.equal(refreshed, 1);

  calls.length = 0;
  await act(async () => root.render(createElement(MultipleProviderIdReport, { entries: entries(1, 337142), initialScanning: false, onChanged() {} })));
  await act(async () => button(container, "Use automatic").click());
  assert.deepEqual(calls[0].body, { identity: "plex://show/scooby", provider: "tmdb", seriesId: null });
});

test("a pending selection says the next scan compares it", async t => {
  const pending = selection(337142); pending.tmdb.current = { ...pending.tmdb.current!, preferredId: 2150, usingId: 2150 };
  const { container, root } = mountDom(t, { fetch: fetcher([], () => Response.json({ selection: pending })) });
  await act(async () => root.render(createElement(MultipleProviderIdReport, { entries: entries(), initialScanning: false, onChanged() {} })));
  await act(async () => (container.querySelector('input[value="337142"]') as HTMLInputElement).click());
  await act(async () => button(container, "Save override").click());
  assert.match(container.textContent || "", /Override saved; the next Plex scan downloads and compares it/);
});

test("changes are disabled during a scan, and a rejected save shows the persisted selection", async t => {
  const calls: Call[] = [];
  const { container, root } = mountDom(t, { fetch: fetcher(calls, () => Response.json({ error: "Wait for the current Plex scan to finish before changing the comparison catalogue.", code: "scan-active", selection: selection() }, { status: 409 })) });
  await act(async () => root.render(createElement(MultipleProviderIdReport, { entries: entries(), initialScanning: true, onChanged() {} })));
  assert.equal((container.querySelector('input[value="337142"]') as HTMLInputElement).disabled, true);
  assert.equal(button(container, "Save override").disabled, true);
  assert.match(container.textContent || "", /A Plex scan is running/);

  // An editor opened before the scan started: the server rejects it.
  await act(async () => root.render(createElement(MultipleProviderIdReport, { key: "idle", entries: entries(), initialScanning: false, onChanged() {} })));
  await act(async () => (container.querySelector('input[value="337142"]') as HTMLInputElement).click());
  await act(async () => button(container, "Save override").click());
  assert.equal(calls.length, 1);
  assert.match(container.textContent || "", /Wait for the current Plex scan to finish/);
  assert.equal((container.querySelector('input[value="2150"]') as HTMLInputElement).checked, true, "the persisted choice is shown again");
});

test("a linked show on a later page is opened on its page", async t => {
  const list = entries(12);
  const target = list[11];
  const { browser, container, root } = mountDom(t, { fetch: fetcher([], () => Response.json({})) });
  browser.location.hash = multipleProviderIdsHref(target.identity).split("#")[1];
  await act(async () => root.render(createElement(MultipleProviderIdReport, { entries: list, initialScanning: false, onChanged() {} })));
  assert.ok(container.querySelector(`[id="${target.anchor}"]`), "the linked entry is rendered");
  assert.match(container.textContent || "", /2 \/ 2/);
});
