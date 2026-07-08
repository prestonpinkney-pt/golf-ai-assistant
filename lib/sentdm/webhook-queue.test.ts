/**

 * Dedupe-key helpers + webhook verification matrix (Sent.dm production readiness).

 */

import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { join } from "node:path";

import { createHmac } from "node:crypto";

import { afterEach, describe, test } from "node:test";

import { NextRequest } from "next/server";

import type { SupabaseClient } from "@supabase/supabase-js";



import {

  computeWebhookJobDedupeKey,

} from "./webhook-job-dedupe";

import { enqueueSentDmInboundWebhookJob } from "./webhook-queue";

import {

  SENTDM_DEV_UNSIGNED_LOG,

  isSentDmSignedDevWebhooksRequired,

  isSentDmUnsignedDevWebhooksAllowed,

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


type FakeWebhookJobRow = {
  id: string;
  provider: string;
  event_type: string;
  external_id: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: string;
  last_error?: string | null;
  processed_at?: string | null;
  updated_at?: string | null;
};

function fakeWebhookJobSupabase(rows: FakeWebhookJobRow[]) {
  let nextId = rows.length + 1;
  return {
    from(table: string) {
      assert.equal(table, "webhook_jobs");
      return {
        insert(row: Omit<FakeWebhookJobRow, "id">) {
          return {
            select(_cols: string) {
              return {
                maybeSingle() {
                  if (
                    row.external_id &&
                    rows.some(
                      (existing) =>
                        existing.provider === row.provider &&
                        existing.external_id === row.external_id
                    )
                  ) {
                    return Promise.resolve({
                      data: null,
                      error: { code: "23505", message: "duplicate key" },
                    });
                  }
                  const inserted: FakeWebhookJobRow = {
                    ...row,
                    id: `job-${nextId++}`,
                  };
                  rows.push(inserted);
                  return Promise.resolve({
                    data: { id: inserted.id },
                    error: null,
                  });
                },
              };
            },
          };
        },
        update(patch: Partial<FakeWebhookJobRow>) {
          const filters: Array<(row: FakeWebhookJobRow) => boolean> = [];
          const chain = {
            eq(field: keyof FakeWebhookJobRow, value: unknown) {
              filters.push((row) => row[field] === value);
              return chain;
            },
            select(_cols: string) {
              return {
                maybeSingle() {
                  const row = rows.find((candidate) =>
                    filters.every((filter) => filter(candidate))
                  );
                  if (!row) {
                    return Promise.resolve({ data: null, error: null });
                  }
                  Object.assign(row, patch);
                  return Promise.resolve({ data: { id: row.id }, error: null });
                },
              };
            },
          };
          return chain;
        },
      };
    },
  };
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


describe("enqueueSentDmInboundWebhookJob", () => {
  test("requeues failed duplicate jobs so provider retries are processed", async () => {
    const rows: FakeWebhookJobRow[] = [
      {
        id: "job-failed-1",
        provider: "sentdm",
        event_type: "message.received",
        external_id: "sentdm:msg-retry-1",
        payload: { payload: { message_id: "msg-retry-1", text: "old" } },
        metadata: { ingest_source: "sentdm_webhook" },
        status: "failed",
        last_error: "sentdm_lookup_timeout",
        processed_at: "2026-07-08T10:00:00.000Z",
      },
    ];

    const result = await enqueueSentDmInboundWebhookJob(
      fakeWebhookJobSupabase(rows) as unknown as SupabaseClient,
      {
        payload: { payload: { message_id: "msg-retry-1", text: "new" } },
        eventType: "message.received",
        ingestSource: "sentdm_webhook",
      }
    );

    assert.deepEqual(result, {
      ok: true,
      jobId: "job-failed-1",
      duplicate: false,
      requeued: true,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].last_error, null);
    assert.equal(rows[0].processed_at, null);
    assert.deepEqual(rows[0].payload, {
      payload: { message_id: "msg-retry-1", text: "new" },
    });
  });

  test("keeps completed duplicate jobs deduped", async () => {
    const rows: FakeWebhookJobRow[] = [
      {
        id: "job-completed-1",
        provider: "sentdm",
        event_type: "message.received",
        external_id: "sentdm:msg-done-1",
        payload: { payload: { message_id: "msg-done-1" } },
        metadata: { ingest_source: "sentdm_webhook" },
        status: "completed",
        last_error: null,
        processed_at: "2026-07-08T10:00:00.000Z",
      },
    ];

    const result = await enqueueSentDmInboundWebhookJob(
      fakeWebhookJobSupabase(rows) as unknown as SupabaseClient,
      {
        payload: { payload: { message_id: "msg-done-1", text: "dupe" } },
        eventType: "message.received",
        ingestSource: "sentdm_webhook",
      }
    );

    assert.deepEqual(result, { ok: true, duplicate: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "completed");
    assert.deepEqual(rows[0].payload, {
      payload: { message_id: "msg-done-1" },
    });
  });
});



describe("verifySentDmAuthenticity", () => {

  const prevEnv = { ...process.env };



  afterEach(() => {

    Object.assign(process.env, prevEnv);

  });



  test("development rejects unsigned when secret configured (HMAC required)", () => {

    Object.assign(process.env, {

      NODE_ENV: "development",

      SENTDM_WEBHOOK_SECRET: "secret",

    });

    delete process.env.SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS;

    delete process.env.SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS;

    const body = "{}";

    const req = new NextRequest("http://localhost/api/sentdm/webhook", {

      method: "POST",

      headers: { "content-type": "application/json" },

      body,

    });

    const r = verifySentDmAuthenticity(req, body);

    assert.equal(r.ok, false);

    if (!r.ok) assert.match(r.reason, /Missing/i);

    assert.equal(isSentDmUnsignedDevWebhooksAllowed(), false);

  });



  test("development accepts unsigned only when SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS=true", () => {

    Object.assign(process.env, {

      NODE_ENV: "development",

      SENTDM_WEBHOOK_SECRET: "secret",

      SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS: "true",

    });

    delete process.env.SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS;

    const body = "{}";

    const req = new NextRequest("http://localhost/api/sentdm/webhook", {

      method: "POST",

      headers: { "content-type": "application/json" },

      body,

    });

    const logs: string[] = [];

    const orig = console.warn;

    console.warn = (...args: unknown[]) => {

      logs.push(args.map(String).join(" "));

    };

    try {

      const r = verifySentDmAuthenticity(req, body);

      assert.equal(r.ok, true);

      if (r.ok) assert.equal(r.mode, "development_unsigned_allowed");

      assert.ok(logs.some((l) => l.includes(SENTDM_DEV_UNSIGNED_LOG)));

      assert.equal(isSentDmUnsignedDevWebhooksAllowed(), true);

    } finally {

      console.warn = orig;

    }

  });



  test("development rejects unsigned when SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS=true", () => {

    Object.assign(process.env, {

      NODE_ENV: "development",

      SENTDM_WEBHOOK_SECRET: "secret",

      SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS: "true",

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

    assert.equal(isSentDmSignedDevWebhooksRequired(), true);

    assert.equal(isSentDmUnsignedDevWebhooksAllowed(), false);

  });



  test("development accepts unsigned without secret by default", () => {

    Object.assign(process.env, {

      NODE_ENV: "development",

    });

    delete process.env.SENTDM_WEBHOOK_SECRET;

    delete process.env.SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS;

    const body = "{}";

    const req = new NextRequest("http://localhost/api/sentdm/webhook", {

      method: "POST",

      headers: { "content-type": "application/json" },

      body,

    });

    const r = verifySentDmAuthenticity(req, body);

    assert.equal(r.ok, true);

    if (r.ok) assert.equal(r.mode, "development_no_secret");

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



  test("production accepts shared secret header", () => {

    Object.assign(process.env, {

      NODE_ENV: "production",

      SENTDM_WEBHOOK_SECRET: "secret",

    });

    const body = '{"a":1}';

    const req = new NextRequest("http://localhost/api/sentdm/webhook", {

      method: "POST",

      headers: {

        "content-type": "application/json",

        "x-sentdm-secret": "secret",

      },

      body,

    });

    const r = verifySentDmAuthenticity(req, body);

    assert.equal(r.ok, true);

    if (r.ok) assert.equal(r.mode, "shared_secret_header");

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

