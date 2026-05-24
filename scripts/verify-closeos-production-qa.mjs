#!/usr/bin/env node
/**
 * CloseOS production QA gate — run locally and in CI after build/typecheck.
 * Usage: node scripts/verify-closeos-production-qa.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
process.exitCode = 0;
const ciMode =
  process.argv.includes("--ci") ||
  process.env.VERIFY_CLOSEOS_QA_CI === "1" ||
  process.env.CI === "true";

function ok(label) {
  console.log(`  ✓ ${label}`);
}

function fail(label, detail) {
  console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
  process.exitCode = 1;
}

function run(cmd, args, env = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

console.log("CloseOS production QA verification\n");

const mvpPages = [
  "app/(dashboard)/dashboard/page.tsx",
  "app/(dashboard)/dashboard/dashboard-client.tsx",
  "app/(dashboard)/messages/page.tsx",
  "app/(dashboard)/opportunities/page.tsx",
  "app/(dashboard)/outbound/page.tsx",
  "app/(dashboard)/outbound/[campaignId]/page.tsx",
  "app/(dashboard)/campaigns/page.tsx",
  "app/(dashboard)/revenue-recovery/page.tsx",
  "app/(dashboard)/settings/page.tsx",
];

console.log("1. MVP route files");
for (const rel of mvpPages) {
  const path = join(root, rel);
  if (existsSync(path)) ok(rel);
  else fail(rel, "missing");
}

console.log("\n2. Campaign operator gates (static)");
const campaignSend = readFileSync(
  join(root, "app/api/campaigns/[campaignId]/send/route.ts"),
  "utf8"
);
if (/requireBusinessUser/.test(campaignSend) && /\.eq\("status", "approved"\)/.test(campaignSend)) {
  ok("campaign send requires auth + approved-only");
} else {
  fail("campaign send operator gate");
}

const campaignApprove = readFileSync(
  join(root, "app/api/campaigns/[campaignId]/approve/route.ts"),
  "utf8"
);
if (/requireBusinessUser/.test(campaignApprove)) ok("campaign approve requires auth");
else fail("campaign approve operator gate");

console.log("\n3. Sent.dm inbound loop guards (static)");
const inboundLoop = readFileSync(join(root, "lib/sentdm/inbound-loop.ts"), "utf8");
const checks = [
  ["sms_opt_out", /sms_opt_out/],
  ["businessRulesGate", /businessRulesGate\(/],
  ["live outbound policy", /evaluateInboundLiveOutboundPolicy/],
];
for (const [label, re] of checks) {
  if (re.test(inboundLoop)) ok(`inbound-loop ${label}`);
  else fail(`inbound-loop missing ${label}`);
}

console.log("\n4. Ops scripts (safe dry checks)");
const messagingEnv = run("node", ["scripts/verify-messaging-env.mjs", "--ci"]);
if (messagingEnv.status === 0) ok("verify:messaging-env --ci");
else fail("verify:messaging-env --ci", messagingEnv.stderr?.slice(0, 200));

if (ciMode) {
  ok("sync:square-customers skipped in CI (requires live Square credentials)");
  ok("check:revenue-recovery skipped in CI (requires Supabase + business id)");
} else {
  const syncScript = run("node", ["--import", "tsx", "scripts/sync-square-customers.mjs"], {
    CLOSEOS_BUSINESS_ID: "",
    BUSINESS_ID: "",
  });
  if (syncScript.status !== 0 && /CLOSEOS_BUSINESS_ID|BUSINESS_ID/.test(syncScript.stderr || syncScript.stdout || "")) {
    ok("sync:square-customers fails closed without business id");
  } else if (syncScript.status === 0) {
    ok("sync:square-customers ran (env configured)");
  } else {
    fail("sync:square-customers unexpected exit", syncScript.stderr?.slice(0, 120));
  }

  const recoveryScript = run("node", ["--import", "tsx", "scripts/check-revenue-recovery-reachability.mjs"]);
  if (recoveryScript.status === 0) ok("check:revenue-recovery");
  else if (/CLOSEOS_BUSINESS_ID|Missing Supabase|not configured/i.test(`${recoveryScript.stderr}${recoveryScript.stdout}`)) {
    ok("check:revenue-recovery fails closed without full env");
  } else {
    fail("check:revenue-recovery", recoveryScript.stderr?.slice(0, 120));
  }
}

console.log("\n5. QA test bundle");
const qaTests = run("node", [
  "--import",
  "./tests/stub-server-only.cjs",
  "--import",
  "tsx",
  "--test",
  "lib/agent/business-rules-gate.test.ts",
  "lib/campaigns/campaign-operator-gate.test.ts",
]);
if (qaTests.status === 0) ok("test:qa");
else fail("test:qa", (qaTests.stderr || qaTests.stdout || "").slice(0, 200));

if (process.exitCode) {
  console.error("\nCloseOS production QA: FAIL");
  process.exit(process.exitCode);
}

console.log("\nCloseOS production QA: PASS");
