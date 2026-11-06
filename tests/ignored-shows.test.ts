import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { activeIgnores, createIgnoreTiming, ignoredPlexKeys, ignoredTraktIds, isIgnoreActive, type IgnoreTiming } from "../lib/ignored-shows";

test("extracts valid ignored Trakt IDs and skips malformed settings", () => {
  assert.deepEqual([...ignoredTraktIds([{ ids: { trakt: 12 } }, null, { ids: { trakt: "13" } }, { ids: { trakt: 14 } }])], [12, 14]);
});

test("extracts valid ignored Plex identity keys", () => {
  assert.deepEqual([...ignoredPlexKeys([{ ratingKey: "plex://show/one" }, { ratingKey: "" }, {}, { ratingKey: "ratingKey:2" }])], ["plex://show/one", "ratingKey:2"]);
});

test("30-day and 90-day ignores expire after exact elapsed days from selection", () => {
  const selectedAt = new Date("2026-03-07T18:23:45.678Z");
  for (const [duration, days] of [["30d", 30], ["90d", 90]] as const) {
    const timing = createIgnoreTiming(duration, selectedAt);
    assert.deepEqual(timing, { duration, expiresAt: new Date(selectedAt.getTime() + days * 86_400_000).toISOString() });
  }
  assert.equal(selectedAt.toISOString(), "2026-03-07T18:23:45.678Z");
});

test("six-month ignores clamp the local calendar day across year and leap boundaries", () => {
  const examples = [
    { selected: new Date(2026, 7, 31, 14, 23, 45, 678), year: 2027, month: 1, day: 28 },
    { selected: new Date(2027, 7, 31, 14, 23, 45, 678), year: 2028, month: 1, day: 29 },
    { selected: new Date(2026, 9, 31, 14, 23, 45, 678), year: 2027, month: 3, day: 30 },
  ];
  for (const { selected, year, month, day } of examples) {
    const before = selected.getTime();
    const timing = createIgnoreTiming("6m", selected);
    const expiry = new Date(timing.expiresAt!);
    assert.equal(timing.duration, "6m");
    assert.deepEqual(
      [expiry.getFullYear(), expiry.getMonth(), expiry.getDate(), expiry.getHours(), expiry.getMinutes(), expiry.getSeconds(), expiry.getMilliseconds()],
      [year, month, day, 14, 23, 45, 678],
    );
    assert.equal(selected.getTime(), before);
  }
});

test("six-month ignores use the selecting device's calendar across daylight saving time", () => {
  const helperUrl = new URL("../lib/ignored-shows.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { createIgnoreTiming } from ${JSON.stringify(helperUrl)};
    const selected = new Date(2026, 2, 7, 12, 30);
    const expiry = new Date(createIgnoreTiming("6m", selected).expiresAt);
    assert.deepEqual([selected.getTimezoneOffset(), expiry.getTimezoneOffset()], [360, 300]);
    assert.deepEqual([expiry.getFullYear(), expiry.getMonth(), expiry.getDate(), expiry.getHours(), expiry.getMinutes()], [2026, 8, 7, 12, 30]);
    assert.equal(expiry.getTime() - selected.getTime(), 184 * 86400000 - 3600000);
  `], { encoding: "utf8", env: { ...process.env, TZ: "America/Chicago" } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("legacy ignores and Forever remain active while deadlines expire at the exact instant", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  assert.deepEqual(createIgnoreTiming("forever", new Date(now)), { duration: "forever" });
  assert.equal(isIgnoreActive({}, now), true);
  assert.equal(isIgnoreActive(createIgnoreTiming("forever", new Date(now)), now + 1_000_000_000_000), true);
  assert.equal(isIgnoreActive({ expiresAt: new Date(now + 1).toISOString() }, now), true);
  assert.equal(isIgnoreActive({ expiresAt: new Date(now).toISOString() }, now), false);
  assert.equal(isIgnoreActive({ expiresAt: new Date(now - 1).toISOString() }, now), false);
  assert.equal(isIgnoreActive({ expiresAt: "invalid" }, now), false);
  assert.equal(isIgnoreActive({ expiresAt: "" }, now), false);
});

test("active ignore filtering preserves independent whole-show and season rules", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  const wholeShow = { key: "show|12", expiresAt: new Date(now).toISOString() };
  const seasons = { key: "seasons|12", seasons: [1, 2], expiresAt: new Date(now + 1).toISOString() };
  const legacy = { key: "show|13" };
  const rules: (IgnoreTiming & { key: string; seasons?: number[] })[] = [wholeShow, seasons, legacy];
  assert.deepEqual(activeIgnores(rules, now), [seasons, legacy]);
  assert.deepEqual(rules, [wholeShow, seasons, legacy]);
});

test("scanner identity sets use the captured scan time even if an ignore later expires", () => {
  const scanStarted = Date.parse("2026-11-06T12:00:00.000Z");
  const expiresAt = new Date(scanStarted + 1).toISOString();
  const trakt = [{ ids: { trakt: 12 }, expiresAt }, { ids: { trakt: 13 } }, { ids: { trakt: 14 }, expiresAt: "invalid" }];
  const plex = [{ ratingKey: "plex://show/one", expiresAt }, { ratingKey: "ratingKey:2" }, { ratingKey: "bad", expiresAt: "invalid" }];
  assert.deepEqual([...ignoredTraktIds(trakt, scanStarted)], [12, 13]);
  assert.deepEqual([...ignoredPlexKeys(plex, scanStarted)], ["plex://show/one", "ratingKey:2"]);
  assert.deepEqual([...ignoredTraktIds(trakt, scanStarted + 1)], [13]);
  assert.deepEqual([...ignoredPlexKeys(plex, scanStarted + 1)], ["ratingKey:2"]);
});
