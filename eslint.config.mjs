import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const RAW_SAVED_SCAN_STATE = "Only the Ignore module (lib/ignore-results.ts) may use the raw saved scan state store; use savedScanState from @/lib/ignore-results so Ignore pruning applies.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The raw saved scan state store skips Ignore pruning. Any reference to it by name
  // (a static, namespace or dynamic import, or a re-export) is rejected outside the
  // module that defines it, the Ignore module and the raw store's own test.
  {
    ignores: ["lib/sqlite.ts", "lib/ignore-results.ts", "tests/raw-saved-scan-state.test.ts"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "Identifier[name='rawSavedScanState']", message: RAW_SAVED_SCAN_STATE },
        { selector: "Literal[value='rawSavedScanState']", message: RAW_SAVED_SCAN_STATE },
      ],
    },
  },
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
