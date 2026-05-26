#!/usr/bin/env node
/**
 * Sign a Sent.dm webhook JSON body for HMAC verification tests.
 *
 * Usage (print headers only):
 *   node scripts/sign-sentdm-webhook.mjs tests/fixtures/sentdm/inbound-with-message-id.json
 *
 * Production-style local POST (signed HMAC + timestamp) — default when secret is set:
 *   Set SENTDM_WEBHOOK_SECRET
 *   npm run test:sentdm-webhook:signed
 *
 * Unsigned smoke only (not integration):
 *   SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS=true
 *
 * Requires SENTDM_WEBHOOK_SECRET in env or .env.local
 */
import { createHmac, randomUUID as randomUUIDCrypto } from "node:crypto";
const crypto = { randomUUID: randomUUIDCrypto };
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const args = process.argv.slice(2);
const postMode = args[0] === "--post";
const fileArg = postMode ? args[1] : args[0];

if (!fileArg) {
  console.error(
    "Usage:\n  node scripts/sign-sentdm-webhook.mjs <json-file|->\n  node scripts/sign-sentdm-webhook.mjs --post <json-file|->"
  );
  process.exit(1);
}

const secret = process.env.SENTDM_WEBHOOK_SECRET?.trim();
if (!secret) {
  console.error("SENTDM_WEBHOOK_SECRET is required");
  process.exit(1);
}

const rawBody =
  fileArg === "-"
    ? readFileSync(0, "utf8")
    : readFileSync(resolve(process.cwd(), fileArg), "utf8");

const webhookId = crypto.randomUUID();
const timestamp = String(Math.floor(Date.now() / 1000));

// Sent.dm v3 signing: HMAC-SHA256({id}.{ts}.{body}) with base64-decoded whsec_ key
const secretStripped = secret.replace(/^whsec_/, "");
const keyBytes = Buffer.from(secretStripped, "base64");
const signedContent = `${webhookId}.${timestamp}.${rawBody}`;
const sigB64 = createHmac("sha256", keyBytes).update(signedContent).digest("base64");

const headers = {
  "Content-Type": "application/json",
  "x-webhook-id": webhookId,
  "x-webhook-timestamp": timestamp,
  "x-webhook-signature": `v1,${sigB64}`,
};

if (!postMode) {
  console.log(
    JSON.stringify(
      {
        note: "Use these headers when POSTing the same raw JSON body bytes.",
        ...headers,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
  /\/$/,
  ""
);
const url = `${baseUrl}/api/sentdm/webhook`;

console.log("--- Sent.dm production-style signed webhook test ---");
console.log(`Fixture: ${fileArg}`);
console.log(`POST ${url}`);
console.log("verificationMode: hmac_sha256_body (expected when accepted)");
console.log(
  `SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS=${process.env.SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS ?? "(unset — HMAC required when secret is set)"}`
);

const res = await fetch(url, {
  method: "POST",
  headers,
  body: rawBody,
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
    "\nJob queued with message_id fixture — enrichment will call GET /v3/messages/{id}."
  );
  console.log(
    "If after() does not drain locally, run:\n  npm run drain:sentdm-webhook-jobs"
  );
}

if (!res.ok) process.exit(1);
