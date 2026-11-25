import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { harness, type Episode } from "./report-missing-harness";

// ADR-0008 through an upgrade: Manual Matches an earlier release saved as Pending or Needs review
// grant coverage on the next ordinary Plex scan. The upgrade itself compares nothing again, and that
// scan reuses the saved catalogues.

// TMDB numbers the season S1; TVDB numbers the same episodes S2, so only a Manual Match covers them.
const tmdb1: Episode = { provider: "TMDB", id: 9001, season: 1, episode: 1, name: "One" };
const tmdb2: Episode = { provider: "TMDB", id: 9002, season: 1, episode: 2, name: "Two" };
const tvdb1: Episode = { provider: "TVDB", id: 301, season: 2, episode: 1, name: "One" };
const tvdb2: Episode = { provider: "TVDB", id: 302, season: 2, episode: 2, name: "Two" };
type Coverage = { pending: number; issues: { id: string }[] };
const catalogueRequest = (path: string) => /^\/3\/tv\/\d+(\/season\/\d+)?$|^\/v4\/series\/\d+(\/episodes\/default)?$/.test(path);

test("Manual Matches saved as Pending or Needs review grant coverage on the next ordinary scan after upgrading", async t => {
  const h = await harness(t, [tmdb1, tmdb2, tvdb1, tvdb2], [tmdb1, tmdb2]);
  const before = await h.rerun();
  assert.deepEqual(h.missing(before), { "TVDB:301": "missing", "TVDB:302": "missing" });
  const db = () => (globalThis as typeof globalThis & { __shelfcheckDatabase?: DatabaseSync }).__shelfcheckDatabase!;
  // The report as the earlier release left it: its Pending and Needs review matches covered nothing.
  const oldReport = (db().prepare("SELECT report FROM shelfcheck_scan_state WHERE mode='plex'").get() as { report: string }).report;
  for (const members of [[tmdb1, tvdb1], [tmdb2, tvdb2]]) assert.equal((await h.save(members)).status, 201);
  const coverage = async () => ((await h.status()) as unknown as { coverage: Coverage }).coverage;
  for (let i = 0; i < 100 && (await coverage()).pending; i++) await new Promise(resolve => setTimeout(resolve, 10));
  // A scan with these matches downloads the catalogues their save asked for, so a later scan reuses them.
  await h.rerun();
  const [pending, broken] = await h.mappings();

  // Step the database back to the earlier release's: saved health, a member check, its report and a Resume point.
  const revision = (db().prepare("SELECT revision FROM shelfcheck_coverage_state").get() as { revision: number }).revision;
  const setHealth = (id: string, health: Record<string, string>) => {
    const row = db().prepare("SELECT payload FROM shelfcheck_coverage_mappings WHERE id=?").get(id) as { payload: string };
    db().prepare("UPDATE shelfcheck_coverage_mappings SET payload=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.payload), ...health }), id);
  };
  setHealth(pending.id, { health: "pending", healthMessage: "Provider identity could not be verified. Coverage is pending; retry the scan or review the episode context." });
  setHealth(broken.id, { health: "needs-review", healthMessage: "A provider episode record was not found. Resolve and review replacements to repair this Manual Match." });
  const memberCheck = `member-verification:${broken.id}:TVDB:302`;
  db().prepare("INSERT INTO shelfcheck_coverage_issues VALUES(?,?)").run(memberCheck, JSON.stringify({ id: memberCheck, operation: "member-verification", provider: "TVDB", scope: "episode", mappingId: broken.id, cause: "404 — record not found", action: "Edit and review this Manual Match to repair the missing member." }));
  const resumePoint = { shows: JSON.parse(oldReport).shows, scanCache: {}, cacheVersion: JSON.parse(oldReport).cacheVersion, savedAt: new Date().toISOString(), autoCompoundEpisodes: true, coverageRevision: revision };
  db().prepare("UPDATE shelfcheck_scan_state SET report=?, resume_point=? WHERE mode='plex'").run(JSON.stringify({ ...JSON.parse(oldReport), coverageRevision: revision }), JSON.stringify(resumePoint));
  db().exec("PRAGMA user_version = 7");
  h.restart();

  const upgraded = await h.status();
  assert.deepEqual(h.missing(upgraded), { "TVDB:301": "missing", "TVDB:302": "missing" }, "Saved results stand until a scan replaces them");
  assert.ok(!(await coverage()).issues.some(issue => issue.id === memberCheck), "The member check is gone");
  const raw = db().prepare("SELECT resume_point FROM shelfcheck_scan_state WHERE mode='plex'").get() as { resume_point: string | null };
  assert.equal(raw.resume_point, null, "The old Resume point is rejected");
  for (const mapping of await h.mappings()) assert.equal("health" in mapping || "healthMessage" in mapping, false, "No health is listed");

  h.requests.length = 0;
  const after = await h.rerun();
  assert.deepEqual(h.missing(after), {}, "Both Manual Matches cover their TVDB episodes");
  assert.deepEqual(h.requests.filter(catalogueRequest), [], "Saved catalogues are reused: the upgrade forces no download");
  assert.ok(!h.requests.some(path => path === "/3/tv/10/season/1/episode/1" || path === "/v4/episodes/301/extended"), "No Manual Match member is requested");
});
