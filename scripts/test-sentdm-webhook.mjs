#!/usr/bin/env node
/**
 * POST unsigned Sent.dm webhook fixtures — **local smoke only**.
 *
 * Works in NODE_ENV=development by default (no extra env flags).
 * For production-style signed testing:
 *   Set SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS=true
 *   Set SENTDM_WEBHOOK_SECRET
 *   npm run test:sentdm-webhook:signed
 *
 * Usage (dev server must be running on NEXT_PUBLIC_APP_URL):
 *   npm run test:sentdm-webhook:smoke
 *   node scripts/test-sentdm-webhook.mjs inbound-message-id
 *   node scripts/test-sentdm-webhook.mjs delivery
 *   node scripts/test-sentdm-webhook.mjs malformed
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FIXTURES = {
  "inbound-text": "tests/fixtures/sentdm/inbound-text-only.local.json",
  "inbound-message-id": "tests/fixtures/sentdm/inbound-with-message-id.json",
  delivery: "tests/fixtures/sentdm/delivery-status.json",
  malformed: "tests/fixtures/sentdm/malformed-no-text-no-id.json",
};

function loadEnvLocal() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* optional */
  }
}

loadEnvLocal();

const mode = process.argv[2] ?? "inbound-text";
const fixtureRel = FIXTURES[mode];
if (!fixtureRel) {
  console.error(
    `Unknown mode "${mode ?? ""}". Use: ${Object.keys(FIXTURES).join(" | ")}`
  );
  process.exit(1);
}

const requireSignedDev =
  process.env.SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS?.trim().toLowerCase() === "true";

const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
  /\/$/,
  ""
);
const url = `${baseUrl}/api/sentdm/webhook`;
const body = readFileSync(resolve(process.cwd(), fixtureRel), "utf8");

console.log("--- Sent.dm local webhook SMOKE test (unsigned) ---");
console.log(
  "Development accepts unsigned webhooks by default. For production-style testing, use npm run test:sentdm-webhook:signed."
);
console.log(`Mode: ${mode}`);
console.log(`Fixture: ${fixtureRel}`);
console.log(`POST ${url}`);
console.log(
  `SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS=${requireSignedDev ? "true (unsigned smoke will 401 — unset for default dev)" : "false (default)"}`
);
console.log(
  "Signed alternative:\n  Set SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS=true\n  Set SENTDM_WEBHOOK_SECRET\n  npm run test:sentdm-webhook:signed"
);

if (requireSignedDev) {
  console.warn(
    "\nWarning: SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS=true — unsigned smoke tests will return 401. Unset for default local dev."
  );
}

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});

const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  json = { raw: text };
}

console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(json, null, 2));

if (json?.queued === true && json?.job_id) {
  console.log(
    "\nJob queued. In local dev, after() may not drain webhook_jobs — run:\n  npm run drain:sentdm-webhook-jobs"
  );
}

if (!res.ok) process.exit(1);
