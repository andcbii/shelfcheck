import assert from "node:assert/strict";
import test from "node:test";
import { createScanRunLifecycle, ScanRunConflictError, type ScanRunKind } from "../lib/scan-run";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** A lifecycle with its own owner record and a fake clock, isolated from the production record. */
function lifecycle(now = Date.parse("2026-11-18T12:00:00.000Z")) {
  const clock = { now: () => now };
  return createScanRunLifecycle({ clock, state: {} });
}

for (const [running, refused] of [["plex", "trakt"], ["trakt", "plex"], ["trakt", "trakt"], ["plex", "plex"]] as [ScanRunKind, ScanRunKind][]) {
  test(`a ${refused} scan run is refused while a ${running} scan run is active`, async () => {
    const runs = lifecycle();
    const work = deferred();
    runs.start(running, () => work.promise);
    let refusedBodyRan = false;
    assert.throws(() => runs.start(refused, async () => { refusedBodyRan = true; }), (error: unknown) => {
      assert.ok(error instanceof ScanRunConflictError);
      assert.equal(error.status, 409);
      assert.equal(error.owner.kind, running);
      assert.match(error.message, new RegExp(`A ${running === "plex" ? "Plex" : "Trakt"} scan is running`));
      return true;
    });
    assert.equal(refusedBodyRan, false, "a refused start runs none of its body");
    assert.equal(runs.activeScanRun()?.kind, running);
    work.resolve();
  });
}

test("the owner record carries the kind, a unique run identity and the clock's start time", () => {
  const runs = lifecycle(Date.parse("2026-11-18T09:30:00.000Z"));
  const first = runs.start("plex", async () => {});
  assert.deepEqual({ kind: first.owner.kind, startedAt: first.owner.startedAt }, { kind: "plex", startedAt: "2026-11-18T09:30:00.000Z" });
  assert.deepEqual(runs.activeScanRun(), first.owner);
  assert.ok(first.owner.runId);
});

test("the run body receives its own owner record", async () => {
  const runs = lifecycle();
  let seen: unknown;
  const started = runs.start("trakt", async (owner) => { seen = owner; });
  await started.settled;
  assert.deepEqual(seen, started.owner);
});

test("ownership is released only after the run's work settles, and a new run can then start", async () => {
  const runs = lifecycle();
  const work = deferred();
  const first = runs.start("trakt", () => work.promise);
  await Promise.resolve();
  assert.equal(runs.isActive("trakt"), true);
  assert.equal(runs.isActive("plex"), false);
  assert.equal(runs.isActive(), true);
  work.resolve();
  await first.settled;
  assert.equal(runs.activeScanRun(), null);
  const second = runs.start("plex", async () => {});
  assert.notEqual(second.owner.runId, first.owner.runId);
});

test("a run whose work fails still releases ownership, and its failure reaches whoever awaits it", async () => {
  const runs = lifecycle();
  const started = runs.start("plex", async () => { throw new Error("provider down"); });
  await assert.rejects(started.settled, /provider down/);
  assert.equal(runs.activeScanRun(), null);
});

test("a run whose setup fails synchronously releases ownership and reports the failure", () => {
  const runs = lifecycle();
  assert.throws(() => runs.start("plex", () => { throw new Error("Run a full Plex search first."); }), /full Plex search/);
  assert.equal(runs.activeScanRun(), null);
  runs.start("trakt", async () => {});
  assert.equal(runs.activeScanRun()?.kind, "trakt");
});

for (const [first, second] of [["trakt", "plex"], ["plex", "trakt"], ["plex", "plex"], ["trakt", "trakt"]] as [ScanRunKind, ScanRunKind][]) {
  test(`simultaneous ${first} then ${second} starts give exactly one active scan run`, async () => {
    const runs = lifecycle();
    const work = deferred();
    let bodies = 0;
    const attempt = async (kind: ScanRunKind) => { await Promise.resolve(); return runs.start(kind, () => { bodies += 1; return work.promise; }); };
    const outcomes = await Promise.allSettled([attempt(first), attempt(second)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "rejected"]);
    assert.ok((outcomes[1] as PromiseRejectedResult).reason instanceof ScanRunConflictError);
    assert.equal(bodies, 1);
    assert.equal(runs.activeScanRun()?.kind, first);
    work.resolve();
  });
}

test("every lifecycle instance in the process shares the production owner record", async (t) => {
  const global = globalThis as typeof globalThis & { __shelfcheckScanRun?: unknown };
  const previous = global.__shelfcheckScanRun;
  delete global.__shelfcheckScanRun;
  t.after(() => { global.__shelfcheckScanRun = previous; });
  const routeInstance = createScanRunLifecycle();
  const reloadedInstance = createScanRunLifecycle();
  const work = deferred();
  const started = routeInstance.start("plex", () => work.promise);
  assert.throws(() => reloadedInstance.start("trakt", async () => {}), ScanRunConflictError);
  assert.equal(reloadedInstance.activeScanRun()?.runId, started.owner.runId);
  work.resolve();
  await started.settled;
  assert.equal(reloadedInstance.activeScanRun(), null);
});
