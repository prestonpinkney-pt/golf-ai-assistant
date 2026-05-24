import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/** Pre-CloseOS API routes — lint quarantine (behavior unchanged; not MVP shell). */
const legacyApiGlobs = [
  "app/api/follow-ups/**",
  "app/api/integrations/mailchimp/**",
  "app/api/integrations/whoosh/import-profiles/**",
  "app/api/integrations/square/sync-customers/**",
  "app/api/leads/**",
  "app/api/lib/closeos-sales-advisor.ts",
  "app/api/lib/revenue/**",
  "app/api/opportunities/targets/feedback/**",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Test harness + ops scripts (CJS / Node-only; not app product code)
    "tests/**",
    "scripts/**",
    // Legacy dev pages outside CloseOS dashboard MVP
    "app/inbox/**",
    "app/test/**",
    "app/test-sms/**",
    "app/test-ai/**",
    // Pre-CloseOS revenue engine (MVP dashboard uses /api/dashboard/mvp-stats)
    "lib/revenue/**",
    // Whoosh integration WIP — not required for current production QA gate
    "lib/whoosh/**",
  ]),
  {
    files: ["**/*.test.ts", "lib/**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "prefer-const": "off",
    },
  },
  {
    files: legacyApiGlobs,
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "prefer-const": "off",
    },
  },
  {
    files: ["lib/square/customer-directory-sync.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
  {
    files: ["lib/ai/sms-booking-flow.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
]);

export default eslintConfig;
