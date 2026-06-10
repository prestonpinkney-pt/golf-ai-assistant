import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mock, test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { NextRequest, NextResponse } from "next/server";

type HandlerCall = {
  body: Record<string, unknown>;
  verification: { ok: boolean; mode?: string };
  options: {
    route: string;
    webhookEventSource: string;
    ingestSource: string;
    legacyRoute?: boolean;
  };
};

const handlerCalls: HandlerCall[] = [];
const root = process.cwd();

mock.module(
  pathToFileURL(join(root, "lib/sentdm/handle-webhook-post.ts")).href,
  {
    namedExports: {
      handleSentDmWebhookPost: async (
        body: HandlerCall["body"],
        verification: HandlerCall["verification"],
        options: HandlerCall["options"]
      ) => {
        handlerCalls.push({ body, verification, options });
        return NextResponse.json({
          received: true,
          legacy_route: options.legacyRoute === true,
          route: options.route,
        });
      },
    },
  }
);

const { POST } = await import("./route");

function signSha256(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("legacy Sent.dm webhook route delegates to canonical queue handler", async () => {
  handlerCalls.length = 0;
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: "production",
    SENTDM_WEBHOOK_SECRET: "secret",
  });

  try {
    const body = JSON.stringify({
      sub_type: "message.received",
      payload: {
        message_id: "fixture-msg-legacy-001",
        contact_id: "fixture-contact-001",
        from: "+15105550123",
        text: "Hi",
        channel: "sms",
      },
    });
    const req = new NextRequest("http://localhost/api/webhooks/sent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentdm-signature": signSha256(body, "secret"),
      },
      body,
    });

    const res = await POST(req);
    const json = (await res.json()) as Record<string, unknown>;

    assert.equal(res.status, 200);
    assert.equal(json.legacy_route, true);
    assert.equal(json.route, "webhooks/sent");
    assert.equal(handlerCalls.length, 1);
    assert.equal(handlerCalls[0]?.verification.ok, true);
    assert.equal(handlerCalls[0]?.verification.mode, "hmac_sha256_body");
    assert.equal(handlerCalls[0]?.options.route, "webhooks/sent");
    assert.equal(handlerCalls[0]?.options.webhookEventSource, "sentdm");
    assert.equal(handlerCalls[0]?.options.ingestSource, "sentdm_webhook");
    assert.equal(handlerCalls[0]?.options.legacyRoute, true);
    assert.equal(
      (handlerCalls[0]?.body.payload as Record<string, unknown>)?.message_id,
      "fixture-msg-legacy-001"
    );
  } finally {
    process.env = previousEnv;
  }
});
