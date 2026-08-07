import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const versionSource = readFileSync(new URL("../lib/version.ts", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

test("release version agrees across package, application, and changelog metadata", () => {
  const applicationVersion = versionSource.match(/SHELFCHECK_VERSION\s*=\s*"([^"]+)"/)?.[1];
  const newestChangelogVersion = changelog.match(/^##\s+([^\s]+)\s+-/m)?.[1];
  assert.equal(applicationVersion, packageJson.version);
  assert.equal(newestChangelogVersion, packageJson.version);
});
