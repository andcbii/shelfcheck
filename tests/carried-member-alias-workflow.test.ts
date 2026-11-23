import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { api, harness, type Episode } from "./report-missing-harness";

const hook = registerHooks({ resolve(specifier, context, next) { return specifier === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(specifier, context); } });
const { plexSavedState, requestCoverageRecheck } = await import("../lib/plex-scan");
const { carriedMembers, coverageState } = await import("../lib/manual-coverage");
const { database } = await import("../lib/sqlite");
const { readPlexInputs, savePlexComparison } = await import("../lib/plex-catalogues");
hook.deregister();

// Reported in review of PR #112: a show whose saved comparison was lost can hold a carried member
// that another saved comparison also matches through an alias.
test("a lost show comparison keeps carried members another comparison matches through an alias, until a full scan compares the show", async t => {
  const own: Episode = { provider: "TMDB", id: 100, season: 1, episode: 1, name: "Whole" };
  const mapped: Episode = { provider: "TVDB", id: 203, season: 2, episode: 4, name: "Mapped", show: "other" };
  const h = await harness(t, [own, mapped], [own]);
  await h.rerun();
  assert.equal(h.missing(await h.status(), "other")["TVDB:203"], "missing");
  const match = (await (await h.save([own, mapped])).json()).mapping;
  assert.deepEqual(h.missing(await h.status(), "other"), {});

  // Target's saved comparison also matches Other's TVDB series through an alias.
  const target = readPlexInputs().comparisons["ratingKey:target"];
  savePlexComparison("ratingKey:target", { ...target, tvdbAliases: [21] });

  // The delete commits, but its cached recheck fails.
  const read = plexSavedState.report.read.bind(plexSavedState.report);
  let fail = true;
  t.mock.method(plexSavedState.report, "read", () => { if (fail) { fail = false; throw new Error("injected recheck failure"); } return read(); });
  const response = await api.DELETE(new Request(`http://localhost/api/plex/manual-coverage?id=${match.id}`, { method: "DELETE" }));
  assert.equal(response.status, 200);
  assert.equal(coverageState().pending, 1);

  // Other's saved comparison is lost; a retry can compare Target only.
  database().prepare("DELETE FROM shelfcheck_plex_generated_inputs WHERE cache_key='comparison:ratingKey:other'").run();
  await requestCoverageRecheck({ members: [] });
  assert.deepEqual(h.missing(await h.status(), "other"), {}, "Other was not compared, so its last results stay");
  assert.ok(carriedMembers().some(entry => entry.member.provider === "TVDB" && entry.member.id === 203), "the member Other could hold stays carried");
  assert.equal(coverageState().pending, 1);

  // A full scan compares Other again: the deleted match's episode is missing and nothing stays pending.
  await h.rerun();
  assert.equal(h.missing(await h.status(), "other")["TVDB:203"], "missing");
  assert.deepEqual(carriedMembers(), []);
  assert.equal(coverageState().pending, 0);
});
