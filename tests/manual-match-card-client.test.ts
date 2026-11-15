import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, createElement } from "react";
import { ManualCoverageManager } from "../app/components/manual-coverage-manager";
import { ManualMatchCard } from "../app/components/manual-match-card";
import type { CoverageMapping } from "../lib/manual-coverage-model";
import { mountDom } from "./dom-environment";

// Animaniacs "Murder Pals": one combined TMDB episode split over two TVDB episodes.
const combined = { provider: "TMDB" as const, id: 4245050, showId: 107124, show: "Animaniacs", title: "Murder Pals", season: 3, episode: 18, url: "https://www.themoviedb.org/tv/107124/season/3/episode/18" };
const part2 = { provider: "TVDB" as const, id: 9623972, showId: 72879, show: "Animaniacs", title: "Murder Pals (2)", season: 8, episode: 20, url: "https://thetvdb.com/series/animaniacs/episodes/9623972" };
const part3 = { provider: "TVDB" as const, id: 9623973, showId: 72879, show: "Animaniacs", title: "Murder Pals (3)", season: 8, episode: 22, url: "https://thetvdb.com/series/animaniacs/episodes/9623973" };
const split: CoverageMapping = { id: "murder-pals", revision: 3, health: "healthy", members: [combined, part2, part3], createdAt: "2026-11-01T00:00:00Z", evidence: [{ showKey: "show", ratingKey: "42", identities: [{ provider: "TVDB", id: 9623972 }] }] } as CoverageMapping;

async function renderCard(t: test.TestContext, match: CoverageMapping, extra: { selection?: { selected: boolean; onChange: (selected: boolean) => void } } = {}) {
  const { container, root } = mountDom(t);
  const calls: string[] = [];
  await act(async () => root.render(createElement(ManualMatchCard, { match, locked: false, onEdit() { calls.push("edit"); }, onDelete() { calls.push("delete"); }, ...extra })));
  const card = container.querySelector("article")!;
  const panel = (provider: string) => [...card.querySelectorAll(".manual-match-panels > section")].find(section => section.querySelector("header")?.textContent?.startsWith(provider))!;
  const lines = (provider: string) => [...panel(provider).querySelectorAll(".manual-match-episode-line")];
  return { card, calls, panel, lines };
}

test("the card header holds the select checkbox, the health label and the Edit and Delete buttons", async t => {
  const ticks: boolean[] = [];
  const ui = await renderCard(t, split, { selection: { selected: false, onChange: selected => ticks.push(selected) } });
  const header = ui.card.querySelector(":scope > header")!;
  const box = header.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  assert.ok(box, "The select checkbox is in the header");
  assert.equal(header.querySelector(".manual-match-health")?.textContent, "Healthy");
  assert.deepEqual([...header.querySelectorAll("button")].map(button => button.textContent), ["Edit", "Delete"]);
  assert.equal(header.querySelector("button.manual-match-delete")?.textContent, "Delete", "Delete carries the card's own danger styling");
  await act(async () => box.click());
  for (const button of header.querySelectorAll("button")) await act(async () => button.click());
  assert.deepEqual(ticks, [true]);
  assert.deepEqual(ui.calls, ["edit", "delete"]);
  assert.equal(ui.card.querySelector(".manual-match-health-message"), null, "No message line without a message");
  assert.doesNotMatch(ui.card.textContent || "", /Coverage evidence|Plex item|Revision/, "Coverage evidence is no longer on the card");
  assert.equal(ui.card.querySelector("details"), null);
});

test("a Needs review message sits on its own line under the header", async t => {
  const ui = await renderCard(t, { ...split, health: "needs-review", healthMessage: "TVDB no longer lists one of these episodes." });
  assert.equal(ui.card.querySelector(".manual-match-health")?.textContent, "Needs review");
  const message = ui.card.querySelector(":scope > header + .manual-match-health-message");
  assert.equal(message?.textContent, "TVDB no longer lists one of these episodes.");
});

test("each provider column names its show and episode count once and gives every episode one line", async t => {
  const ui = await renderCard(t, split);
  assert.equal(ui.panel("TMDB").querySelector("header")?.textContent, "TMDBAnimaniacsShow 1071241 episode");
  assert.equal(ui.panel("TVDB").querySelector("header")?.textContent, "TVDBAnimaniacsShow 728792 episodes");
  assert.deepEqual(ui.lines("TMDB").map(line => line.textContent), ["S03E18Murder Pals#4245050"]);
  assert.deepEqual(ui.lines("TVDB").map(line => line.textContent), ["S08E20Murder Pals (2)#9623972", "S08E22Murder Pals (3)#9623973"]);
  const links = [...ui.card.querySelectorAll<HTMLAnchorElement>(".manual-match-episode-line a")];
  assert.deepEqual(links.map(link => [link.getAttribute("href"), link.getAttribute("aria-label")]), [
    [combined.url, "Open S03E18 Murder Pals on TMDB"],
    [part2.url, "Open S08E20 Murder Pals (2) on TVDB"],
    [part3.url, "Open S08E22 Murder Pals (3) on TVDB"],
  ]);
  assert.ok(links.every(link => link.target === "_blank" && link.rel === "noreferrer"));
  assert.equal(ui.card.querySelectorAll(".manual-match-episode-status").length, 0, "No status line without a status");
});

test("Reported missing and the derived incomplete status sit on a status line under their episode", async t => {
  const ui = await renderCard(t, { ...split, members: [combined, { ...part2, reportMissing: true }, part3] });
  const status = (provider: string, index: number) => ui.lines(provider)[index].nextElementSibling;
  assert.equal(status("TVDB", 0)?.className, "manual-match-episode-status");
  assert.equal(status("TVDB", 0)?.textContent, "Reported missing");
  assert.notEqual(status("TVDB", 1)?.className, "manual-match-episode-status", "The unflagged part has no status line");
  assert.equal(status("TMDB", 0)?.className, "manual-match-episode-status");
  assert.match(status("TMDB", 0)?.textContent || "", /^Incomplete · mapped part missing Contains TVDB Murder Pals \(2\)/);
});

// Each rule in globals.css as its selector, its @media condition (if any) and its declarations.
const cssRules = (() => {
  const rules: { selector: string; media?: string; body: string }[] = [];
  let media: string | undefined;
  for (const chunk of readFileSync(new URL("../app/globals.css", import.meta.url), "utf8").split("}")) {
    const parts = chunk.split("{");
    if (parts.length < 2) { media = undefined; continue; }
    if (parts.length > 2) media = parts[parts.length - 3].split("\n").pop()!.trim();
    rules.push({ selector: parts[parts.length - 2].split("\n").pop()!.trim(), media, body: parts[parts.length - 1] });
  }
  return rules;
})();
// The value of `property` in the rule whose whole selector is `selector`, at the top level or inside `media`.
function cssValue(selector: string, property: string, media?: string) {
  const rule = cssRules.find(item => item.selector === selector && item.media === media);
  assert.ok(rule, `${selector} has a rule${media ? ` in ${media}` : ""}`);
  return rule.body.split(";").map(item => item.split(":")).find(([name]) => name.trim() === property)?.slice(1).join(":").trim();
}

test("the TMDB column keeps its own height beside a taller TVDB column", () => {
  // The card's columns share one background with only a 1px divider between them, so a shorter column shows no box to stretch.
  assert.equal(cssValue(".manual-match-card .manual-match-panels > section", "border"), "0", "Card columns draw no border of their own");
  assert.equal(cssValue(".manual-match-card .manual-match-panels", "gap"), "1px", "Columns are divided by a 1px line only");
  // Episode lines keep their own height whatever the other column holds.
  assert.equal(cssValue(".manual-match-episode-line", "flex"), undefined);
  assert.equal(cssValue(".manual-match-episode-line", "height"), undefined);
});

test("the editor's review panels align their columns to the top", () => {
  assert.equal(cssValue(".manual-match-panels", "align-items"), "start");
});

test("the card shows TMDB and TVDB side by side, stacking only on small screens", () => {
  assert.equal(cssValue(".manual-match-card .manual-match-panels", "grid-template-columns"), "repeat(2, minmax(0, 1fr))");
  assert.equal(cssValue(".manual-match-card .manual-match-panels", "grid-template-columns", "@media (max-width: 760px)"), "1fr");
});

test("Reported missing has its own tag colours", () => {
  assert.deepEqual(["border-color", "background", "color"].map(property => cssValue(".manual-match-tag.missing", property)), ["#d9825f", "#ffe6dc", "#8a2c0c"]);
});

test("the Matching Episodes popup shows saved episodes in the same compact layout", async t => {
  const { container, root } = mountDom(t, { fetch: async (input: unknown) => {
    if (String(input) === "/api/plex/scan") return Response.json({ scan: { status: "completed" } });
    return Response.json({ mappings: [split], revision: 3, pending: 0 });
  } });
  await act(async () => root.render(createElement(ManualCoverageManager, { initialUrls: [part2.url], onClose() {}, onChanged() {} })));
  const card = container.querySelector("article")!;
  assert.ok(card, "The saved match is shown as a card");
  assert.deepEqual([...card.querySelectorAll(".manual-match-episode-line")].map(line => line.textContent), ["S03E18Murder Pals#4245050", "S08E20Murder Pals (2)#9623972", "S08E22Murder Pals (3)#9623973"]);
  assert.deepEqual([...card.querySelectorAll(":scope > header button")].map(button => button.textContent), ["Edit", "Delete"]);
  const editorLines = [...container.querySelectorAll('[aria-label="Manual Match editor"] .manual-match-episode-line')].filter(line => !card.contains(line));
  assert.equal(editorLines.length, 3, "The editor's episodes use the same one-line layout");
});
