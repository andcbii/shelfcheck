import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const RAW_SAVED_SCAN_STATE = "Only the Ignore module (lib/ignore-results.ts) may use the raw saved scan state store; use savedScanState from @/lib/ignore-results so Ignore pruning applies.";

const SAVED_COVERAGE_ISSUE_IDS = "Only storage reads (lib/coverage-issues.ts and the saved title recovery in lib/tvdb-title-recovery.ts) may adopt saved text as Coverage Issue IDs; build IDs with the constructors in @/lib/coverage-issue-ids.";

// Names restricted to the modules that may use them. Any reference by name (a static, namespace or
// dynamic import, or a re-export) is rejected elsewhere.
// - The raw saved scan state store skips Ignore pruning: only the module that defines it, the Ignore
//   module and the raw store's own test may use it.
// - `savedCoverageIssueIds` adopts saved text as Coverage Issue IDs: only storage reads may use it.
const rawSavedScanStateAllowed = ["lib/sqlite.ts", "lib/ignore-results.ts", "tests/raw-saved-scan-state.test.ts"];
const savedCoverageIssueIdsAllowed = ["lib/coverage-issues.ts", "lib/tvdb-title-recovery.ts"];
const rawSavedScanStateRestriction = [
  { selector: "Identifier[name='rawSavedScanState']", message: RAW_SAVED_SCAN_STATE },
  { selector: "Literal[value='rawSavedScanState']", message: RAW_SAVED_SCAN_STATE },
];
const savedCoverageIssueIdsRestriction = [
  { selector: "Identifier[name='savedCoverageIssueIds']", message: SAVED_COVERAGE_ISSUE_IDS },
  { selector: "Literal[value='savedCoverageIssueIds']", message: SAVED_COVERAGE_ISSUE_IDS },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // One rule setting per file, since a later setting of the same rule replaces an earlier one.
  {
    ignores: [...rawSavedScanStateAllowed, ...savedCoverageIssueIdsAllowed],
    rules: { "no-restricted-syntax": ["error", ...rawSavedScanStateRestriction, ...savedCoverageIssueIdsRestriction] },
  },
  { files: rawSavedScanStateAllowed, rules: { "no-restricted-syntax": ["error", ...savedCoverageIssueIdsRestriction] } },
  { files: savedCoverageIssueIdsAllowed, rules: { "no-restricted-syntax": ["error", ...rawSavedScanStateRestriction] } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
