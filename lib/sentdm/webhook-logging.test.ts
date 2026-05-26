import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  buildSentDmWebhookLogSummary,
  extractSentDmContactId,
  extractSentDmMessageExternalId,
  extractSentDmMessageIdForLookup,
  hasSentDmInboundText,
  inferInboundWebhookLogMode,
  looksLikeDeliveryStatusCallback,
  looksLikeInboundMessage,
  shouldWarnMissingExternalId,
  SENTDM_DEV_UNSIGNED_LOG,
} from "../messaging/sentdm-webhook";
const fixturesDir = join(process.cwd(), "tests/fixtures/sentdm");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(fixturesDir, name), "utf8")
  ) as Record<string, unknown>;
}

describe("extractSentDmMessageExternalId", () => {
  test("payload.message_id is extracted", () => {
    assert.equal(
      extractSentDmMessageExternalId({
        payload: { message_id: "msg-payload-snake" },
      }),
      "msg-payload-snake"
    );
  });

  test("payload.messageId is extracted", () => {
    assert.equal(
      extractSentDmMessageExternalId({
        payload: { messageId: "msg-payload-camel" },
      }),
      "msg-payload-camel"
    );
  });

  test("external_id is extracted", () => {
    assert.equal(
      extractSentDmMessageExternalId({ external_id: "ext-123" }),
      "ext-123"
    );
  });

  test("no id returns null without crashing", () => {
    assert.equal(extractSentDmMessageExternalId({ payload: { channel: "sms" } }), null);
    assert.equal(extractSentDmMessageExternalId({}), null);
  });
});

describe("Sent.dm webhook log planning", () => {
  test("message_id fixture uses integration_message_lookup mode", () => {
    const body = loadFixture("inbound-with-message-id.json");
    const messageId = extractSentDmMessageIdForLookup(body);
    assert.equal(messageId, "sdm-msg-prod-like-001");
    assert.equal(extractSentDmContactId(body), "sdm-contact-prod-like-001");
    const looksInbound = looksLikeInboundMessage(body);
    assert.equal(looksInbound, true);
    assert.equal(
      inferInboundWebhookLogMode({
        body,
        externalId: messageId ?? "",
        looksInbound: true,
        queued: true,
      }),
      "integration_message_lookup"
    );
  });

  test("inbound text-only final summary uses local_text_envelope and queued true", () => {
    const body = loadFixture("inbound-text-only.local.json");
    const looksInbound = looksLikeInboundMessage(body);
    assert.equal(looksInbound, true);
    assert.equal(
      inferInboundWebhookLogMode({
        body,
        externalId: "",
        looksInbound: true,
        queued: true,
      }),
      "local_text_envelope"
    );
    const summary = buildSentDmWebhookLogSummary({
      eventType: "message.received",
      verificationMode: "development_unsigned_allowed",
      body,
      externalId: "",
      status: "unknown",
      looksInbound: true,
      queued: true,
    });
    assert.equal(summary.hasMessageId, false);
    assert.equal(summary.hasText, true);
    assert.equal(summary.looksInbound, true);
    assert.equal(summary.queued, true);
    assert.equal(summary.mode, "local_text_envelope");
  });

  test("delivery callback summary includes queued false and reconciliation fields", () => {
    const body = loadFixture("delivery-status.json");
    const summary = buildSentDmWebhookLogSummary({
      eventType: "message.delivered",
      verificationMode: "hmac_sha256_body",
      body,
      externalId: "sdm-msg-delivery-001",
      status: "delivered",
      looksInbound: false,
      queued: false,
      externalIdPresent: true,
      reconciled: true,
    });
    assert.equal(summary.queued, false);
    assert.equal(summary.externalIdPresent, true);
    assert.equal(summary.reconciled, true);
    assert.equal(summary.mode, undefined);
  });

  test("ignored non-inbound summary includes ignored and reason", () => {
    const summary = buildSentDmWebhookLogSummary({
      eventType: "unknown",
      verificationMode: "development_unsigned_allowed",
      body: {},
      externalId: "",
      status: "unknown",
      looksInbound: false,
      queued: false,
      ignored: true,
      reason: "not_inbound_or_delivery",
    });
    assert.equal(summary.ignored, true);
    assert.equal(summary.reason, "not_inbound_or_delivery");
    assert.equal(summary.queued, false);
  });

  test("handle-webhook-post emits one final structured summary per request", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/sentdm/handle-webhook-post.ts"),
      "utf8"
    );
    assert.equal((source.match(/logSentDmWebhookSummary\(/g) ?? []).length, 1);
    assert.ok(source.includes("emitFinalWebhookLog"));
    assert.equal(source.includes("queued: false,\n    })"), false);
  });

  test("inbound text-only does not warn about missing external_id", () => {
    const body = loadFixture("inbound-text-only.local.json");
    const looksInbound = looksLikeInboundMessage(body);
    assert.equal(looksInbound, true);
    assert.equal(
      shouldWarnMissingExternalId({
        externalId: "",
        looksInbound,
        body,
      }),
      false
    );
    const summary = buildSentDmWebhookLogSummary({
      eventType: "message.received",
      verificationMode: "development_unsigned_allowed",
      body,
      externalId: "",
      status: "unknown",
      looksInbound: true,
      queued: true,
    });
    assert.equal(summary.hasMessageId, false);
    assert.equal(summary.hasText, true);
    assert.equal(summary.looksInbound, true);
    assert.equal(summary.queued, true);
  });

  test("delivery callback without external_id warns for reconciliation", () => {
    const body = {
      sub_type: "message.delivered",
      status: "delivered",
      payload: { status: "delivered" },
    };
    assert.equal(looksLikeDeliveryStatusCallback(body), true);
    assert.equal(
      shouldWarnMissingExternalId({
        externalId: "",
        looksInbound: false,
        body,
      }),
      true
    );
  });

  test("delivery callback with external_id does not warn", () => {
    const body = loadFixture("delivery-status.json");
    assert.equal(
      shouldWarnMissingExternalId({
        externalId: "sdm-msg-delivery-001",
        looksInbound: false,
        body,
      }),
      false
    );
  });

  test("log summary never includes secrets or full message text", () => {
    const body = loadFixture("inbound-text-only.local.json");
    const summary = buildSentDmWebhookLogSummary({
      eventType: "message.received",
      verificationMode: "development_unsigned_allowed",
      body,
      externalId: "",
      status: "unknown",
      looksInbound: true,
    });
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes("Hey Primetime"), false);
    assert.equal(serialized.includes("+1555"), false);
    assert.equal(serialized.includes("WEBHOOK_SECRET"), false);
    assert.ok(Object.keys(summary).includes("hasText"));
  });

  test("dev unsigned log message is clearly labeled for local testing", () => {
    assert.match(SENTDM_DEV_UNSIGNED_LOG, /local testing only/i);
    assert.match(SENTDM_DEV_UNSIGNED_LOG, /DEV unsigned/i);
  });
});

describe("fixture shapes", () => {
  test("inbound-with-message-id fixture uses integration_message_lookup mode", () => {
    const body = loadFixture("inbound-with-message-id.json");
    const externalId = extractSentDmMessageExternalId(body) ?? "";
    assert.equal(externalId, "sdm-msg-prod-like-001");
    assert.equal(hasSentDmInboundText(body), false);
    const looksInbound = looksLikeInboundMessage(body);
    assert.equal(looksInbound, true);
    assert.equal(
      inferInboundWebhookLogMode({
        body,
        externalId,
        looksInbound: true,
        queued: true,
      }),
      "integration_message_lookup"
    );
    const summary = buildSentDmWebhookLogSummary({
      eventType: "message.received",
      verificationMode: "hmac_sha256_body",
      body,
      externalId,
      status: "unknown",
      looksInbound: true,
      queued: true,
    });
    assert.equal(summary.hasMessageId, true);
    assert.equal(summary.mode, "integration_message_lookup");
    assert.equal(summary.verificationMode, "hmac_sha256_body");
  });

  test("delivery-status is a delivery callback", () => {
    const body = loadFixture("delivery-status.json");
    assert.equal(looksLikeInboundMessage(body), false);
    assert.equal(looksLikeDeliveryStatusCallback(body), true);
  });
});
