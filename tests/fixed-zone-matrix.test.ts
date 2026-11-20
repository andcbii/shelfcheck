import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Runs every tests/fixed-zone/*.zone.ts file in its own Node process per zone, with TZ
// set before anything is imported. Add a zone here, or a case file in tests/fixed-zone.
export const ZONES = ["America/Los_Angeles", "Australia/Sydney"] as const;

const root = fileURLToPath(new URL("..", import.meta.url));
const caseFiles = readdirSync(new URL("./fixed-zone/", import.meta.url)).filter((name) => name.endsWith(".zone.ts")).sort().map((name) => `tests/fixed-zone/${name}`);

for (const zone of ZONES) {
  test(`fixed-zone cases pass in ${zone}`, () => {
    assert.ok(caseFiles.length > 0, "no fixed-zone case files found");
    const env: NodeJS.ProcessEnv = { ...process.env, TZ: zone };
    // The parent test runner marks its children; without this the child would report to it in its wire format.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec", ...caseFiles], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, `${zone}:\n${result.stdout}\n${result.stderr}${result.error ? `\n${result.error.message}` : ""}`);
  });
}
