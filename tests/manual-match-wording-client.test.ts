import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { ManualMatchEditor } from "../app/components/manual-match-editor";
import { ManualCoverageManager } from "../app/components/manual-coverage-manager";
import { mountDom } from "./dom-environment";

// GLOSSARY.md: a saved match is a Manual Match, never a "mapping".
const tmdb = {provider:"TMDB",id:100,showId:10,show:"Animaniacs",title:"Combined",season:3,episode:18,url:"https://www.themoviedb.org/tv/10/season/3/episode/18"};
const tvdb = {provider:"TVDB",id:200,showId:20,show:"Animaniacs",title:"Part 1",season:3,episode:18,url:"https://thetvdb.com/dereferrer/episode/200"};
const saved = [
  {id:"first",revision:1,members:[tmdb,tvdb]},
  {id:"second",revision:1,members:[{...tmdb,id:101,title:"Other"},{...tvdb,id:201,title:"Other"}]},
];

type Reply = (method: string, body: Record<string, unknown> | null) => Promise<Response> | Response;
async function mount(t: test.TestContext, element: (root: Root) => void, reply: Reply, mappings: unknown[]) {
  const { container, root } = mountDom(t, { fetch: async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/plex/scan") return Response.json({scan:{status:"completed"}});
    const method = init?.method || "GET";
    if (method === "GET") return Response.json({mappings,revision:1,pending:0});
    return reply(method, init?.body ? JSON.parse(String(init.body)) : null);
  } });
  await act(async()=>element(root));
  const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label);
  const click = async (label: string) => { const target = button(label); assert.ok(target, label); await act(async()=>target.click()); };
  // Everything a sighted or screen reader user meets: visible text and accessible names.
  const sayNoMapping = (state: string) => {
    assert.doesNotMatch(container.textContent || "", /mapping/i, `${state}: visible text`);
    for (const element of container.querySelectorAll("*")) for (const name of ["aria-label","title","placeholder","alt"]) {
      assert.doesNotMatch(element.getAttribute(name) || "", /mapping/i, `${state}: ${name} on <${element.tagName.toLowerCase()}>`);
    }
  };
  return { container, button, click, sayNoMapping };
}

test("the Manual Matches page renders no mapping text when empty", async t => {
  const ui = await mount(t, root => root.render(createElement(ManualMatchEditor,{initialUrls:[],onChanged(){},report:true})), () => Response.json({}), []);
  assert.match(ui.container.textContent || "", /No Manual Matches/);
  ui.sayNoMapping("Empty page");
});

test("the Manual Matches page says Manual Match through its list, selection, editor and messages", async t => {
  // Failed requests reject without an Error, so the page falls back to its own messages.
  const ui = await mount(t, root => root.render(createElement(ManualMatchEditor,{initialUrls:[],onChanged(){},report:true})), (method, body) => {
    if (method === "DELETE") return body ? Response.json({deleted:["second"],missing:["gone"],revision:2,pending:0}) : Promise.reject("offline");
    if (body?.action === "resolve") return Response.json({preview:"reviewed",members:[tmdb,tvdb]});
    return Promise.reject("offline");
  }, saved);
  ui.sayNoMapping("List");
  assert.equal(ui.container.querySelector('[aria-label="Health"]'), null, "No health filter");

  const tick = ui.container.querySelector<HTMLInputElement>('article input[type="checkbox"]');
  assert.equal(tick?.getAttribute("aria-label"), "Select Manual Match first");
  await act(async()=>tick!.click());
  assert.ok(ui.button("Select all 2 Manual Matches"));
  ui.sayNoMapping("Selection");

  await ui.click("Select all 2 Manual Matches");
  await ui.click("Delete 2 selected matches");
  await ui.click("Delete 2 matches");
  assert.match(ui.container.textContent || "", /Deleted 1 Manual Match\. 1 selected Manual Match was already removed\./);
  ui.sayNoMapping("Bulk delete");

  const deleteButton = ui.container.querySelector<HTMLButtonElement>("article .manual-match-delete")!;
  await act(async()=>deleteButton.click());
  await ui.click("Delete match");
  assert.match(ui.container.textContent || "", /Could not delete the Manual Match\./);
  ui.sayNoMapping("Failed delete");

  await act(async()=>ui.container.querySelector<HTMLButtonElement>("article header button:not(.manual-match-delete)")!.click());
  assert.match(ui.container.querySelector('[role="dialog"]')?.getAttribute("aria-label") || "", /^Edit Manual Match · /);
  await ui.click("Resolve and review");
  await ui.click("Save Manual Match");
  assert.match(ui.container.textContent || "", /Could not save the Manual Match\./);
  ui.sayNoMapping("Failed save");
});

test("the Matching Episodes popup says Manual Match while editing a saved one", async t => {
  const part2 = {...tvdb,id:202,title:"Part 2",url:"https://thetvdb.com/dereferrer/episode/202"};
  const mappings: unknown[] = [saved[0]];
  const ui = await mount(t, root => root.render(createElement(ManualCoverageManager,{initialUrls:["tvdb:202","tvdb:203"],onClose(){},onChanged(){}})), (_method, body) => {
    // As the server does, resolving a new draft that shares an episode with a saved Manual Match opens that one.
    if (body?.action === "resolve") return Response.json(body.id === undefined ? {members:[part2],existingMapping:saved[0]} : {preview:"reviewed",members:[tmdb,tvdb]});
    const mapping = {...saved[0],revision:2}; mappings.splice(0, mappings.length, mapping);
    return Response.json({mapping,revision:2});
  }, mappings);
  ui.sayNoMapping("New draft");
  await ui.click("Resolve and review");
  assert.match(ui.container.textContent || "", /This episode already belongs to a Manual Match\./);
  ui.sayNoMapping("Existing Manual Match");
  await ui.click("Resolve and review");
  await ui.click("Save Manual Match");
  assert.match(ui.container.textContent || "", /Editing Manual Match first · Revision 2/);
  ui.sayNoMapping("Saved");
});
