/**

 * Dedupe-key helpers + webhook verification matrix (Sent.dm production readiness).

 */

import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { join } from "node:path";

import { createHmac } from "node:crypto";

import { afterEach, describe, test } from "node:test";

import { NextRequest } from "next/server";



import {

  computeWebhookJobDedupeKey,

} from "./webhook-job-dedupe";
import {

  enqueueSentDmInboundWebhookJob,

} from "./webhook-queue";

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

type WebhookJobTestRow = {
  id: string;
  provider: string;
  external_id: string | null;
  status: string;
  payload?: Record<string, unknown>;
  event_type?: string;
  metadata?: Record<string, unknown>;
  last_error?: string | null;
  processed_at?: string | null;
  updated_at?: string | null;
};

function createWebhookQueueMockSupabase(initialRows: WebhookJobTestRow[]) {
  const rows = initialRows.map((row) => ({ ...row }));

  type Filter = { field: string; value: unknown };

  function matching(filters: Filter[]) {
    return rows.filter((row) =>
      filters.every((filter) => row[filter.field as keyof WebhookJobTestRow] === filter.value)
    );
  }

  const supabase = {
    from(table: string) {
      assert.equal(table, "webhook_jobs");
      const filters: Filter[] = [];
      let pendingInsert: Partial<WebhookJobTestRow> | null = null;
      let pendingUpdate: Partial<WebhookJobTestRow> | null = null;

      const api = {
        insert(row: Partial<WebhookJobTestRow>) {
          pendingInsert = row;
          return api;
        },
        update(patch: Partial<WebhookJobTestRow>) {
          pendingUpdate = patch;
          return api;
        },
        select() {
          return api;
        },
        eq(field: string, value: unknown) {
          filters.push({ field, value });
          return api;
        },
        async maybeSingle() {
          if (pendingInsert) {
            const duplicate = rows.some(
              (row) =>
                row.external_id !== null &&
                row.external_id === pendingInsert?.external_id
            );
            if (duplicate) {
              return { data: null, error: { code: "23505", message: "duplicate key" } };
            }
            const row = {
              id: `job-${rows.length + 1}`,
              provider: "sentdm",
              status: "pending",
              external_id: null,
              ...pendingInsert,
            } as WebhookJobTestRow;
            rows.push(row);
            return { data: { id: row.id }, error: null };
          }

          if (pendingUpdate) {
            const row = matching(filters)[0] ?? null;
            if (row) {
              Object.assign(row, pendingUpdate);
              return { data: { id: row.id }, error: null };
            }
            return { data: null, error: null };
          }

          return { data: matching(filters)[0] ?? null, error: null };
        },
      };

      return api;
    },
    _rows: rows,
  };

  return supabase;
}



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

describe("enqueueSentDmInboundWebhookJob", () => {

  test("reopens a failed duplicate job so provider retries are processed", async () => {

    const supabase = createWebhookQueueMockSupabase([

      {

        id: "job-existing",

        provider: "sentdm",

        external_id: "sentdm:retry-message-1",

        status: "failed",

        last_error: "temporary Sent.dm lookup timeout",

        processed_at: "2026-06-01T10:00:00.000Z",

      },

    ]);



    const result = await enqueueSentDmInboundWebhookJob(supabase as never, {

      payload: { payload: { message_id: "retry-message-1" } },

      eventType: "message.received",

      ingestSource: "sentdm_webhook",

    });



    assert.deepEqual(result, { ok: true, jobId: "job-existing", duplicate: false });

    assert.equal(supabase._rows[0]?.status, "pending");

    assert.equal(supabase._rows[0]?.last_error, null);

    assert.equal(supabase._rows[0]?.processed_at, null);

  });



  test("keeps completed duplicate jobs idempotent", async () => {

    const supabase = createWebhookQueueMockSupabase([

      {

        id: "job-completed",

        provider: "sentdm",

        external_id: "sentdm:completed-message-1",

        status: "completed",

      },

    ]);



    const result = await enqueueSentDmInboundWebhookJob(supabase as never, {

      payload: { payload: { message_id: "completed-message-1" } },

      eventType: "message.received",

      ingestSource: "sentdm_webhook",

    });



    assert.deepEqual(result, { ok: true, duplicate: true });

    assert.equal(supabase._rows[0]?.status, "completed");

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

