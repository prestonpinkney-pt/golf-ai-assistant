/**
 * Local / CI check: required env vars for outbound SMS and webhooks.
 * Loads `.env*` from the project root (same precedence as Next) before reading `process.env`.
 * Does not print secret values — only booleans and non-secret names.
 *
 * Usage: node scripts/verify-messaging-env.mjs
 */

import { createRequire } from "node:module";
import { join } from "node:path";

const ciMode =
  process.argv.includes("--ci") ||
  process.env.VERIFY_MESSAGING_ENV_CI === "1" ||
  process.env.CI === "true";

const require = createRequire(import.meta.url);
const root = process.cwd();

function loadEnvFromProjectRoot() {
  try {
    const { loadEnvConfig } = require("@next/env");
    loadEnvConfig(root);
    return "@next/env";
  } catch {
    try {
      const dotenv = require("dotenv");
      dotenv.config({ path: join(root, ".env.local") });
      dotenv.config({ path: join(root, ".env") });
      return "dotenv";
    } catch {
      console.warn(
        "[verify-messaging-env] Could not load @next/env or dotenv; relying on shell env only.",
      );
      return null;
    }
  }
}

loadEnvFromProjectRoot();

let provider = (process.env.CLOSEOS_MESSAGING_PROVIDER || "sentdm")
  .trim()
  .toLowerCase();

const present = (name) =>
  Boolean(process.env[name] && String(process.env[name]).trim());

function resolveSentDmSendModeDisplay() {
  const raw = String(process.env.SENTDM_SEND_MODE || "template").trim().toLowerCase();
  return raw === "direct_text" ? "direct_text" : "template";
}

function resolveSentDmAuthModeDisplay() {
  const raw = String(process.env.SENTDM_AUTH_MODE ?? "")
    .trim()
    .toLowerCase();
  return raw === "bearer" ? "bearer" : "x_api_key";
}

function resolveApiKeyMeta() {
  if (present("SENTDM_API_KEY"))
    return { key_configured: true, key_source: "SENTDM_API_KEY" };
  if (present("SENT_API_KEY"))
    return { key_configured: true, key_source: "SENT_API_KEY" };
  if (present("SENT_DM_API_KEY"))
    return { key_configured: true, key_source: "SENT_DM_API_KEY" };
  return { key_configured: false, key_source: "none" };
}

(function printMessagingEnvSummary() {
  const key = resolveApiKeyMeta();
  console.log(`send_mode: ${resolveSentDmSendModeDisplay()}`);
  console.log(`auth_mode: ${resolveSentDmAuthModeDisplay()}`);
  console.log(`key_configured: ${key.key_configured}`);
  console.log(`key_source: ${key.key_source}`);
  console.log(`template_configured: ${present("SENT_DM_TEMPLATE_ID")}`);
  console.log(`webhook_secret_configured: ${present("SENTDM_WEBHOOK_SECRET")}`);
  console.log(
    `require_signed_dev_webhooks: ${String(process.env.SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS ?? "").trim().toLowerCase() === "true"}`,
  );
  console.log(
    `allow_unsigned_dev_webhooks: ${String(process.env.SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS ?? "").trim().toLowerCase() === "true"}`,
  );
  console.log(
    `live_agent_test_mode: ${String(process.env.CLOSEOS_LIVE_AGENT_TEST_MODE ?? "").trim().toLowerCase() === "true"}`,
  );
  console.log(
    `test_sms_allowlist_configured: ${Boolean(process.env.CLOSEOS_TEST_SMS_ALLOWLIST?.trim())}`,
  );
})();

const issues = [];

if (provider === "twilio") {
  console.warn(
    "[verify-messaging-env] CLOSEOS_MESSAGING_PROVIDER=twilio is ignored; CloseOS is Sent.dm-only.",
  );
  provider = "sentdm";
}

if (provider !== "sentdm") {
  issues.push(
    `CLOSEOS_MESSAGING_PROVIDER must be "sentdm" (got "${provider}")`,
  );
}

if (provider === "sentdm") {
  const apiKeyPresent =
    present("SENTDM_API_KEY") ||
    present("SENT_API_KEY") ||
    present("SENT_DM_API_KEY");
  if (!apiKeyPresent) {
    issues.push(
      "Missing Sent.dm API key (set SENTDM_API_KEY, SENT_API_KEY, or SENT_DM_API_KEY)",
    );
  }

  const sendMode = String(process.env.SENTDM_SEND_MODE || "template")
    .trim()
    .toLowerCase();
  if (sendMode === "template" || sendMode === "") {
    if (!present("SENT_DM_TEMPLATE_ID")) {
      issues.push(
        "SENTDM_SEND_MODE=template requires SENT_DM_TEMPLATE_ID (needed for SMS template sends and RCS fallback)",
      );
    }
  }

  if (!present("SENTDM_WEBHOOK_SECRET")) {
    issues.push(
      "Missing SENTDM_WEBHOOK_SECRET (Sent.dm webhook validation)",
    );
  }
}

if (ciMode) {
  console.log(
    "[verify-messaging-env] CI mode: script executed (secret validation skipped)",
  );
  process.exit(0);
}

if (issues.length) {
  console.error("[verify-messaging-env] Failures:");
  for (const line of issues) console.error(`  - ${line}`);
  process.exit(1);
}

console.log("[verify-messaging-env] OK (secrets not printed)");
