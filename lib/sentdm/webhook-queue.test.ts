/**
 * Dedupe-key helpers + webhook verification matrix (Sent.dm production readiness).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { NextRequest } from "next/server";

import { computeWebhookJobDedupeKey } from "./webhook-job-dedupe";
import {
  sentDmWebhookSignatureHeaderPresence,
  verifySentDmAuthenticity,
} from "../messaging/sentdm-webhook";

const fixturesPath = join(
  process.cwd(),
  "scripts",
  "sentdm-webhook-job-fixtures.json"
);
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as Record<
  string,
  unknown
>;

function signSha256(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("computeWebhookJobDedupeKey", () => {
  test("stable key from payload.message_id", () => {
    const body = fixtures.message_received_missing_text as Record<
      string,
      unknown
    >;
    assert.equal(
      computeWebhookJobDedupeKey(body),
      "sentdm:fixture-msg-no-text-001"
    );
  });

  test("duplicate envelope shares dedupe key", () => {
    const a = fixtures.duplicate_same_message_id as Record<string, unknown>;
    const b = { ...(fixtures.duplicate_same_message_id as object) };
    assert.equal(computeWebhookJobDedupeKey(a), computeWebhookJobDedupeKey(b));
  });

  test("missing_message_id yields null dedupe key", () => {
    const body = fixtures.missing_message_id_no_text as Record<
      string,
      unknown
    >;
    assert.equal(computeWebhookJobDedupeKey(body), null);
  });
});

describe("verifySentDmAuthenticity", () => {
  const prevEnv = { ...process.env };

  afterEach(() => {
    Object.assign(process.env, prevEnv);
  });

  test("development allows unsigned when secret configured", () => {
    Object.assign(process.env, {
      NODE_ENV: "development",
      SENTDM_WEBHOOK_SECRET: "secret",
    });
    const body = "{}";
    const req = new NextRequest("http://localhost/api/sentdm/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const r = verifySentDmAuthenticity(req, body);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.mode, "development_unsigned_allowed");
  });

  test("production rejects missing signature when secret configured", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      SENTDM_WEBHOOK_SECRET: "secret",
    });
    const body = "{}";
    const req = new NextRequest("http://localhost/api/sentdm/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const r = verifySentDmAuthenticity(req, body);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /Missing/i);
  });

  test("production rejects invalid HMAC signature", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      SENTDM_WEBHOOK_SECRET: "secret",
    });
    const body = '{"a":1}';
    const req = new NextRequest("http://localhost/api/sentdm/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentdm-signature": "sha256=deadbeef",
      },
      body,
    });
    const r = verifySentDmAuthenticity(req, body);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /Invalid/i);
  });

  test("production accepts valid HMAC signature", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      SENTDM_WEBHOOK_SECRET: "secret",
    });
    const body = '{"a":1}';
    const req = new NextRequest("http://localhost/api/sentdm/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentdm-signature": signSha256(body, "secret"),
      },
      body,
    });
    const r = verifySentDmAuthenticity(req, body);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.mode, "hmac_sha256_body");
  });

  test("rejects stale timestamp when signature headers present", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      SENTDM_WEBHOOK_SECRET: "secret",
    });
    const body = "{}";
    const oldTs = String(Math.floor(Date.now() / 1000) - 99999);
    const req = new NextRequest("http://localhost/api/sentdm/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentdm-signature": signSha256(body, "secret"),
        "x-sentdm-timestamp": oldTs,
      },
      body,
    });
    const r = verifySentDmAuthenticity(req, body);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /timestamp/i);
  });
});

describe("sentDmWebhookSignatureHeaderPresence", () => {
  test("reports presence booleans without secrets", () => {
    const req = new NextRequest("http://localhost/", {
      method: "POST",
      headers: {
        "x-sentdm-signature": "sha256=abc",
        "x-sentdm-timestamp": "1",
      },
      body: "{}",
    });
    const p = sentDmWebhookSignatureHeaderPresence(req);
    assert.equal(p["x-sentdm-signature"], true);
    assert.equal(p["x-sentdm-timestamp"], true);
    assert.equal(p["x-sentdm-secret"], false);
  });
});