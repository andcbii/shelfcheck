import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ESLint } from "eslint";

// Lint lets only the Ignore module use the raw saved scan state store, so no write can
// skip Ignore pruning; other database users stay allowed.
const root = path.resolve(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: root });
async function boundaryErrors(file: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return result.messages.filter(message => message.message.includes("raw saved scan state")).map(message => message.line);
}

test("a module other than the Ignore module cannot use the raw saved scan state store, however it imports it", async () => {
  const forbidden = {
    "a named import": 'import { rawSavedScanState } from "@/lib/sqlite";\nrawSavedScanState("plex");\n',
    "a relative import": 'import { rawSavedScanState as raw } from "./sqlite";\nraw("plex");\n',
    "a namespace import": 'import * as sqlite from "@/lib/sqlite";\nsqlite.rawSavedScanState("plex");\n',
    "a dynamic import": 'const sqlite = await import("../lib/sqlite");\nsqlite.rawSavedScanState("plex");\n',
    "a re-export": 'export { rawSavedScanState } from "@/lib/sqlite";\n',
  };
  for (const [kind, code] of Object.entries(forbidden)) {
    assert.notDeepEqual(await boundaryErrors("lib/some-store.ts", code), [], `${kind} in lib is rejected`);
    assert.notDeepEqual(await boundaryErrors("tests/some-workflow.test.ts", code), [], `${kind} in a test is rejected`);
  }
});

test("other database users and the Ignore module stay allowed", async () => {
  assert.deepEqual(await boundaryErrors("lib/some-store.ts", 'import { database } from "@/lib/sqlite";\ndatabase().prepare("SELECT 1").get();\n'), []);
  assert.deepEqual(await boundaryErrors("tests/some-workflow.test.ts", 'const { savedScanState } = await import("../lib/ignore-results");\nsavedScanState("plex").report.read();\n'), []);
  assert.deepEqual(await boundaryErrors("lib/ignore-results.ts", 'import { rawSavedScanState } from "@/lib/sqlite";\nrawSavedScanState("plex");\n'), []);
});
