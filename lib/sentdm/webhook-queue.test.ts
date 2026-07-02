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

  enqueueSentDmInboundWebhookJob,

} from "./webhook-queue";

import {

  computeWebhookJobDedupeKey,

} from "./webhook-job-dedupe";

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



type MockWebhookJobRow = Record<string, unknown>;



function createWebhookQueueMockSupabase(initialRows: MockWebhookJobRow[] = []) {

  const rows = initialRows;

  function matches(row: MockWebhookJobRow, filters: Array<[string, unknown]>) {

    return filters.every(([field, value]) => row[field] === value);

  }



  const client = {

    from(table: string) {

      assert.equal(table, "webhook_jobs");

      let pendingInsert: MockWebhookJobRow | null = null;

      let pendingUpdate: MockWebhookJobRow | null = null;

      const filters: Array<[string, unknown]> = [];

      const api = {

        insert(row: MockWebhookJobRow) {

          pendingInsert = row;

          return api;

        },

        update(patch: MockWebhookJobRow) {

          pendingUpdate = patch;

          return api;

        },

        select() {

          return api;

        },

        eq(field: string, value: unknown) {

          filters.push([field, value]);

          return api;

        },

        async maybeSingle() {

          if (pendingInsert) {

            const externalId = pendingInsert.external_id;

            const conflict =

              externalId ?

                rows.find(

                  (row) =>

                    row.provider === pendingInsert?.provider &&

                    row.external_id === externalId

                )

              : null;

            if (conflict) {

              return {

                data: null,

                error: { code: "23505", message: "duplicate key value" },

              };

            }



            const inserted = {

              id: `job-${rows.length + 1}`,

              ...pendingInsert,

            };

            rows.push(inserted);

            return { data: { id: inserted.id }, error: null };

          }



          if (pendingUpdate) {

            const row = rows.find((candidate) => matches(candidate, filters));

            if (!row) return { data: null, error: null };

            Object.assign(row, pendingUpdate);

            return { data: { id: row.id }, error: null };

          }



          return { data: null, error: null };

        },

      };

      return api;

    },

    __rows: rows,

  };



  return client as unknown as SupabaseClient & { __rows: MockWebhookJobRow[] };

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

  test("requeues a failed duplicate job so provider retries are processed", async () => {

    const payload = { payload: { message_id: "retry-message-001" } };

    const supabase = createWebhookQueueMockSupabase([

      {

        id: "existing-job",

        provider: "sentdm",

        external_id: "sentdm:retry-message-001",

        status: "failed",

        processed_at: "2026-07-02T00:00:00.000Z",

        last_error: "transient_sentdm_lookup_failure",

        payload: { stale: true },

      },

    ]);



    const result = await enqueueSentDmInboundWebhookJob(supabase, {

      payload,

      eventType: "message.received",

      ingestSource: "sentdm_webhook",

    });



    assert.equal(result.ok, true);

    if (!result.ok) throw new Error("enqueue failed");

    assert.equal(result.duplicate, false);

    if (!result.duplicate) {

      assert.equal(result.jobId, "existing-job");

      assert.equal(result.requeued, true);

    }

    assert.equal(supabase.__rows[0].status, "pending");

    assert.equal(supabase.__rows[0].processed_at, null);

    assert.equal(supabase.__rows[0].last_error, null);

    assert.deepEqual(supabase.__rows[0].payload, payload);

  });



  test("keeps completed duplicate jobs deduped", async () => {

    const payload = { payload: { message_id: "completed-message-001" } };

    const supabase = createWebhookQueueMockSupabase([

      {

        id: "completed-job",

        provider: "sentdm",

        external_id: "sentdm:completed-message-001",

        status: "completed",

      },

    ]);



    const result = await enqueueSentDmInboundWebhookJob(supabase, {

      payload,

      eventType: "message.received",

      ingestSource: "sentdm_webhook",

    });



    assert.equal(result.ok, true);

    if (!result.ok) throw new Error("enqueue failed");

    assert.deepEqual(result, { ok: true, duplicate: true });

    assert.equal(supabase.__rows[0].status, "completed");

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

