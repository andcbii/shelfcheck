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
  let resolvedInputs: string[] = [];
  let rejectSave = true;
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch: async (input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.action === "resolve") {
          resolvedInputs = body.urls;
          return Response.json({ preview: "reviewed", members });
        }
        if (rejectEdit) return Response.json({ error: "This mapping changed. Reopen it.", code: "stale-revision", mappingId: "saved" }, { status: 409 });
        if (rejectSave) return Response.json({error:"This episode already belongs to a mapping."},{status:409});
        savedPreview = body.preview;
        savedId = body.id;
        savedRevision = body.revision;
        return Response.json({ revision: 3 });
      }
      if (init?.method === "DELETE") {
        deleted = String(input);
        return Response.json({ revision: 2 });
      }
      return Response.json({ mappings: [{ id: "saved", revision: 1, health: "needs-review", healthMessage: "Provider confirmed deletion.", members }, {id:"healthy", revision:2, members}], pending: 0 });
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
  await act(async () => root.render(createElement(ManualCoverageManager, { initialUrls: ["tmdb:100 show:10 season:1 episode:1", "tvdb:200"], onClose: () => {
    }, onChanged: () => {
      changed++;
    } })));
  assert.match(container.textContent || "", /Target/);
  assert.match(container.textContent || "", /Other/);
  assert.match(container.textContent || "", /200/);
  assert.match(container.textContent || "", /Needs review/);
  assert.match(container.textContent || "", /Provider confirmed deletion/);
  assert.equal(container.querySelectorAll("article").length,2);
  const healthFilter = container.querySelector<HTMLSelectElement>('[aria-label="Mapping health"]');
  assert.ok(healthFilter);
  await act(async () => {healthFilter.value="needs-review";healthFilter.dispatchEvent(new browser.Event("change",{bubbles:true}) as unknown as Event);});
  assert.equal(container.querySelectorAll("article").length,1);
  const initialResolve = [...container.querySelectorAll("button")].find(button => button.textContent === "Resolve and review");
  assert.ok(initialResolve);
  await act(async () => initialResolve.click());
  assert.deepEqual(resolvedInputs, ["tmdb:100 show:10 season:1 episode:1", "tvdb:200"]);
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
  assert.match(container.querySelector('[role="alert"]')?.textContent || "", /already belongs/);
  assert.ok(container.querySelector('[aria-label="Resolved episode preview"]'));
  assert.equal(changed, 1, "Rejected save does not publish a mapping change");
  rejectSave = false;
  await act(async () => save.click());
  assert.equal(savedPreview, "reviewed");
  assert.equal(savedId, "saved");
  assert.equal(savedRevision, 1);
  assert.equal(changed, 2);
  const create = [...container.querySelectorAll("button")].find(button => button.textContent === "Create mapping");
  assert.ok(create, "The manager provides a standalone create action");
  await act(async () => create.click());
  assert.deepEqual([...container.querySelectorAll<HTMLInputElement>("input:not([type=checkbox])")].map(input => input.value), ["", ""]);
  assert.match(container.textContent || "", /tmdb:100 show:10 season:1 episode:2/);
  assert.match(container.textContent || "", /tvdb:200/);
  assert.deepEqual(resolvedInputs, members.map(member => member.url));
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
  assert.match(container.textContent || "", /Editing mapping existing � Revision 4/);
  assert.equal(container.querySelector('[aria-label="Episode URL or provider-qualified ID 1"]')?.getAttribute("value"), "https://example.com/100");
  assert.equal(container.querySelector('[aria-label="Resolved episode preview"]'), null);
  assert.equal(saves, 0);
});


test("bulk cleanup selects Needs review across pages and confirms the exact count", async (t) => {
  const browser = new Window({ url: "http://localhost/plex" });
  const old = new Map<string, PropertyDescriptor | undefined>();
  let mappings = Array.from({length:13},(_,i)=>({id:`mapping-${i}`,revision:1,health:i===12 ? "healthy":"needs-review",members:[],createdAt:"now"}));
  let deleted: string[] = [];
  let fail = false;
  let changed = 0;
  for (const [key,value] of Object.entries({window:browser,document:browser.document,HTMLElement:browser.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,fetch:async (_input:unknown, init?:RequestInit)=>{
    if(init?.method==="DELETE") {
      if(fail) return Response.json({error:"Please retry cleanup."},{status:503});
      deleted = JSON.parse(String(init.body)).ids;
      mappings=mappings.filter(m=>!deleted.includes(m.id));
      return Response.json({deleted,missing:[],revision:2});
    }
    return Response.json({mappings,pending:0});
  }})) {
    old.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  const container=document.createElement("div");
  const root=createRoot(container);
  t.after(async()=>{
    await act(async()=>root.unmount());
    await browser.happyDOM.close();
    for(const [key,value] of old) {if(value) Object.defineProperty(globalThis,key,value); else Reflect.deleteProperty(globalThis,key);}
  });
  await act(async()=>root.render(createElement(ManualCoverageManager,{initialUrls:[],onClose(){},onChanged(){changed++;}})));
  const click=async(label:string)=>{
    const button=[...container.querySelectorAll("button")].find(b=>b.textContent===label);
    assert.ok(button,`button ${label}`);
    await act(async()=>button.click());
  };
  const filter=container.querySelector<HTMLSelectElement>('[aria-label="Mapping health"]')!;
  const changeFilter=async(value:string)=>act(async()=>{filter.value=value;filter.dispatchEvent(new browser.Event("change",{bubbles:true}) as unknown as Event);});
  const next=()=>click("Next \u2192");
  await changeFilter("needs-review");
  assert.equal(container.querySelectorAll("article").length,10);
  await click("Select all 12 matching mappings");
  assert.match(container.textContent||"",/12 mappings selected/);
  await next();
  assert.equal(container.querySelectorAll("article").length,2);
  assert.ok([...container.querySelectorAll<HTMLInputElement>('article input[type="checkbox"]')].every(input=>input.checked));
  await act(async()=>container.querySelector<HTMLInputElement>('article input[type="checkbox"]')!.click());
  assert.match(container.textContent||"",/11 mappings selected/);
  await click("Delete selected mappings");
  assert.match(container.querySelector('[aria-label="Confirm mapping deletion"]')?.textContent||"",/Delete 11 selected mappings/);
  await click("Cancel bulk deletion");
  assert.deepEqual(deleted,[]);
  await changeFilter("all");
  assert.match(container.textContent||"",/0 mappings selected/);
  assert.match(container.textContent||"",/Selection cleared/);
  await changeFilter("needs-review");
  await click("Select all 12 matching mappings");
  await next();
  await click("Delete selected mappings");
  fail=true;
  await click("Confirm delete 12 mappings");
  assert.match(container.querySelector('[role="alert"]')?.textContent||"",/Please retry/);
  assert.equal(changed,0);
  fail=false;
  await click("Confirm delete 12 mappings");
  assert.deepEqual(deleted,Array.from({length:12},(_,i)=>`mapping-${i}`));
  assert.equal(changed,1);
  assert.match(container.textContent||"",/Deleted 12 mappings/);
  assert.match(container.textContent||"",/0 mappings selected/);
  assert.equal(container.querySelectorAll("article").length,0);
  await changeFilter("all");
  assert.equal(container.querySelectorAll("article").length,1);
  assert.match(container.textContent||"",/Showing 1.1 of 1/);
});
