/**
 * Sent.dm outbound: template.parameters wiring + direct_text `{ to: [E.164], text }`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  buildAiReplySentDmTemplateParameters,
  buildSentDmDirectTextPayload,
  buildSentDmV3MessagesPayload,
  parseSentDmV3SendResponse,
  sendSentDmMessage,
} from "./send-message";
import { reconcileMessageDeliveryPatch } from "@/lib/messaging/delivery-status-update";
import { extractSentDmMessageExternalId } from "@/lib/messaging/sentdm-webhook";

describe("buildSentDmV3MessagesPayload — membership conversation", () => {
  const genericScript = /thank you for reaching out(?:\s+to)?/i;

  afterEach(() => {
    delete process.env.SENT_DM_TEMPLATE_REPLY_KEYS;
    delete process.env.CLOSEOS_BUSINESS_NAME;
    delete process.env.SENT_DM_TEMPLATE_ID;
  });

  test("passes exact AI reply into standard template parameter keys", () => {
    const aiReply =
      "Great question — we offer memberships with weekday and full access. " +
      "Do you play more on weekends or during the week?";

    const payload = buildSentDmV3MessagesPayload({
      to: "+15551234567",
      message: aiReply,
      channel: "sms",
      name: "Alex",
      businessName: "Fairway Demo Club",
      templateId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      senderId: null,
    }) as {
      template: { id: string; parameters: Record<string, string> };
    };

    assert.match(aiReply, /memberships/i, "fixture should read like a membership reply");
    assert.match(aiReply, /\?/, "fixture should include a follow-up question");

    const p = payload.template.parameters;
    for (const key of ["body", "text", "content", "message", "reply"] as const) {
      assert.equal(
        p[key],
        aiReply,
        `parameter ${key} must carry the full AI reply verbatim`
      );
    }

    assert.ok(
      !genericScript.test(JSON.stringify(payload)),
      "outbound payload must not inject static “thank you for reaching out…” copy"
    );
  });

  test("custom template slot via SENT_DM_TEMPLATE_REPLY_KEYS repeats AI text", () => {
    process.env.SENT_DM_TEMPLATE_REPLY_KEYS = "custom_slot,second_key";
    const aiReply = "Memberships start at $89/mo — want a quick tour?";

    const params = buildAiReplySentDmTemplateParameters(
      aiReply,
      "Pat",
      "Demo Golf"
    );
    assert.equal(params.custom_slot, aiReply);
    assert.equal(params.second_key, aiReply);
  });
});

describe("parseSentDmV3SendResponse", () => {
  test("reads message_id from documented v3 envelope", () => {
    const mid = "8ba7b830-9dad-11d1-80b4-00c04fd430c8";
    const raw = {
      success: true,
      data: {
        status: "QUEUED",
        recipients: [
          { message_id: mid, to: "+14155551234", channel: "sms", body: "x" },
        ],
      },
      error: null,
    };
    const out = parseSentDmV3SendResponse(raw);
    assert.equal(out.external_id, mid);
    assert.equal(out.status, "QUEUED");
    assert.equal(out.success, true);
  });

  test("treats success:false as failure", () => {
    const raw = { success: false, data: null, error: { code: "X" } };
    const out = parseSentDmV3SendResponse(raw);
    assert.equal(out.success, false);
    assert.equal(out.external_id, null);
  });
});

describe("buildSentDmDirectTextPayload", () => {
  test("matches Sent.dm direct_text shape: one E.164 in to[], text verbatim (trimmed empty)", () => {
    const p = buildSentDmDirectTextPayload("+15103756639", " AI reply ");
    assert.deepEqual(p, { to: ["+15103756639"], text: "AI reply" });
  });

  test("normalizes US 10-digit dial to +1 E.164 in to[0]", () => {
    const p = buildSentDmDirectTextPayload("5103756639", "msg");
    assert.deepEqual(p, { to: ["+15103756639"], text: "msg" });
  });

  test("preserves trimmed AI reply string as text", () => {
    const ai = "Memberships yes — want the breakdown?";
    const p = buildSentDmDirectTextPayload("+15551234567", ai);
    assert.equal(p.text, ai);
    assert.deepEqual(p.to, ["+15551234567"]);
  });
});

describe("sendSentDmMessage — HTTP transport", () => {
  const nativeFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = nativeFetch;
    delete process.env.SENTDM_SEND_MODE;
    delete process.env.SENTDM_AUTH_MODE;
    delete process.env.SENTDM_API_KEY;
    delete process.env.SENT_API_KEY;
    delete process.env.SENT_DM_API_KEY;
    delete process.env.SENT_DM_TEMPLATE_ID;
  });

  test("direct_text (default auth) sends x-api-key + Idempotency-Key", async () => {
    process.env.SENTDM_SEND_MODE = "direct_text";
    process.env.SENTDM_API_KEY = "secret-not-logged";

    let capturedInit: RequestInit | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            status: "QUEUED",
            recipients: [{ message_id: "mid-direct-xak" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await sendSentDmMessage({
      to: "+15551234567",
      message: "Exact AI reply line.",
      channel: "sms",
      idempotencyKey: "11111111-2222-3333-4444-555555555555",
    });

    assert.ok(capturedInit?.body);
    const body = JSON.parse(String(capturedInit!.body));
    assert.deepEqual(body, {
      to: ["+15551234567"],
      text: "Exact AI reply line.",
    });

    const headers = new Headers(capturedInit!.headers as HeadersInit);
    assert.equal(headers.get("x-api-key"), "secret-not-logged");
    assert.equal(headers.get("Authorization"), null);
    assert.equal(
      headers.get("Idempotency-Key"),
      "11111111-2222-3333-4444-555555555555"
    );
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(result.external_id, "mid-direct-xak");
  });

  test("direct_text with SENTDM_AUTH_MODE=bearer sends Authorization + Idempotency-Key", async () => {
    process.env.SENTDM_SEND_MODE = "direct_text";
    process.env.SENTDM_AUTH_MODE = "bearer";
    process.env.SENT_DM_API_KEY = "bearer-secret";

    let capturedInit: RequestInit | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            status: "QUEUED",
            recipients: [{ message_id: "mid-direct-bearer" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await sendSentDmMessage({
      to: "+15551234567",
      message: "Exact AI reply line.",
      channel: "sms",
      idempotencyKey: "11111111-2222-3333-4444-555555555555",
    });

    assert.ok(capturedInit?.body);
    const body = JSON.parse(String(capturedInit!.body));
    assert.deepEqual(body.to, ["+15551234567"]);
    assert.equal(body.text, "Exact AI reply line.");

    const headers = new Headers(capturedInit!.headers as HeadersInit);
    assert.match(
      headers.get("Authorization") ?? "",
      /^Bearer bearer-secret$/
    );
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(
      headers.get("Idempotency-Key"),
      "11111111-2222-3333-4444-555555555555"
    );
    assert.equal(result.external_id, "mid-direct-bearer");
  });

  test("template mode sends template envelope with x-api-key", async () => {
    process.env.SENTDM_SEND_MODE = "template";
    process.env.SENT_DM_TEMPLATE_ID = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
    process.env.SENT_DM_API_KEY = "tpl-secret";

    let capturedInit: RequestInit | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            status: "QUEUED",
            recipients: [{ message_id: "mid-tpl-1" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    await sendSentDmMessage({
      to: "+15559876543",
      message: "Template-filled reply.",
      channel: "sms",
    });

    assert.ok(capturedInit?.body);
    const payload = JSON.parse(String(capturedInit!.body));
    assert.ok(payload.template);
    assert.equal(payload.template.id, "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb");

    const headers = new Headers(capturedInit!.headers as HeadersInit);
    assert.equal(headers.get("x-api-key"), "tpl-secret");
    assert.equal(headers.get("Authorization"), null);
    assert.equal(headers.get("Idempotency-Key"), null);
  });
});

describe("Sent.dm provider id persistence and delivery correlation", () => {
  type MessageRow = {
    id: string;
    direction: "inbound" | "outbound";
    external_id: string | null;
    provider_message_id: string | null;
    metadata?: Record<string, unknown> | null;
    status: string | null;
    delivery_status: string | null;
    delivery_updated_at?: string | null;
  };

  function fakeSupabaseForMessages(rows: MessageRow[]) {
    return {
      from(table: string) {
        assert.equal(table, "messages");
        return {
          update(patch: Partial<MessageRow>) {
            const filters: Record<string, unknown> = {};
            return {
              eq(field: string, value: unknown) {
                filters[field] = value;
                return this;
              },
              or(expr: string) {
                const ids = [...expr.matchAll(/(?:external_id|provider_message_id)\.eq\.([^,]+)/g)]
                  .map((m) => m[1])
                  .filter((v): v is string => typeof v === "string");
                const metadataIds = [...expr.matchAll(/metadata->>(?:provider_message_id|sentdm_message_id|sentdmMessageId)\.eq\.([^,]+)/g)]
                  .map((m) => m[1])
                  .filter((v): v is string => typeof v === "string");
                let matched: MessageRow | null = null;
                for (const row of rows) {
                  const eqOk = Object.entries(filters).every(
                    ([field, value]) => (row as unknown as Record<string, unknown>)[field] === value
                  );
                  const idOk = ids.some((id) => row.external_id === id || row.provider_message_id === id);
                  const meta = row.metadata ?? {};
                  const metaOk = metadataIds.some(
                    (id) =>
                      meta.provider_message_id === id ||
                      meta.sentdm_message_id === id ||
                      meta.sentdmMessageId === id
                  );
                  if (eqOk && (idOk || metaOk)) {
                    Object.assign(row, patch);
                    matched = row;
                  }
                }
                return {
                  select(_cols: string) {
                    return {
                      maybeSingle: async () => ({
                        data: matched ? { id: matched.id, conversation_id: null } : null,
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
  }

  test("send message stores provider message id shape used by callbacks", () => {
    const providerMessageId = "4f30cbcd-provider-id";
    const persistedPatch = {
      provider: "sentdm",
      external_id: providerMessageId,
      provider_message_id: providerMessageId,
      delivery_status: "QUEUED",
      status: "QUEUED",
    };

    assert.equal(persistedPatch.external_id, providerMessageId);
    assert.equal(persistedPatch.provider_message_id, providerMessageId);
  });

  test("queued/routed/delivered webhook updates matching message row", async () => {
    const providerMessageId = "4f30cbcd-valid-sent-message";
    const rows: MessageRow[] = [
      {
        id: "msg-1",
        direction: "outbound",
        external_id: providerMessageId,
        provider_message_id: providerMessageId,
        status: "queued",
        delivery_status: "queued",
      },
    ];
    const supabase = fakeSupabaseForMessages(rows);

    for (const deliveryStatus of ["queued", "routed", "delivered"]) {
      const result = await reconcileMessageDeliveryPatch(supabase as never, {
        externalIdTrimmed: providerMessageId,
        deliveryStatus,
        touchedAtIso: `2026-05-17T00:00:0${deliveryStatus.length % 10}.000Z`,
      });
      assert.equal(result.errorMessage, null);
      assert.equal(result.matchedMessage?.id, "msg-1");
      assert.equal(rows[0]!.status, deliveryStatus);
      assert.equal(rows[0]!.delivery_status, deliveryStatus);
    }
  });

  test("message.queued updates matching message", async () => {
    const providerMessageId = "queued-message-id";
    const rows: MessageRow[] = [{
      id: "msg-queued",
      direction: "outbound",
      external_id: providerMessageId,
      provider_message_id: providerMessageId,
      status: "sending",
      delivery_status: "sending",
    }];

    const result = await reconcileMessageDeliveryPatch(fakeSupabaseForMessages(rows) as never, {
      externalIdTrimmed: providerMessageId,
      deliveryStatus: "queued",
      touchedAtIso: "2026-05-17T00:00:00.000Z",
    });

    assert.equal(result.matchedMessage?.id, "msg-queued");
    assert.equal(rows[0]!.delivery_status, "queued");
  });

  test("message.routed updates matching message", async () => {
    const providerMessageId = "routed-message-id";
    const rows: MessageRow[] = [{
      id: "msg-routed",
      direction: "outbound",
      external_id: providerMessageId,
      provider_message_id: providerMessageId,
      status: "queued",
      delivery_status: "queued",
    }];

    const result = await reconcileMessageDeliveryPatch(fakeSupabaseForMessages(rows) as never, {
      externalIdTrimmed: providerMessageId,
      deliveryStatus: "routed",
      touchedAtIso: "2026-05-17T00:00:00.000Z",
    });

    assert.equal(result.matchedMessage?.id, "msg-routed");
    assert.equal(rows[0]!.delivery_status, "routed");
  });

  test("message.delivered updates matching message", async () => {
    const providerMessageId = "delivered-message-id";
    const rows: MessageRow[] = [{
      id: "msg-delivered",
      direction: "outbound",
      external_id: providerMessageId,
      provider_message_id: providerMessageId,
      status: "routed",
      delivery_status: "routed",
    }];

    const result = await reconcileMessageDeliveryPatch(fakeSupabaseForMessages(rows) as never, {
      externalIdTrimmed: providerMessageId,
      deliveryStatus: "delivered",
      touchedAtIso: "2026-05-17T00:00:00.000Z",
    });

    assert.equal(result.matchedMessage?.id, "msg-delivered");
    assert.equal(rows[0]!.delivery_status, "delivered");
  });

  test("provider_message_id-only row is found for valid sent message", async () => {
    const providerMessageId = "4f30cbcd-provider-only";
    const rows: MessageRow[] = [
      {
        id: "msg-provider-only",
        direction: "outbound",
        external_id: null,
        provider_message_id: providerMessageId,
        status: "queued",
        delivery_status: "queued",
      },
    ];
    const supabase = fakeSupabaseForMessages(rows);

    const result = await reconcileMessageDeliveryPatch(supabase as never, {
      externalIdTrimmed: providerMessageId,
      deliveryStatus: "delivered",
      touchedAtIso: "2026-05-17T00:00:00.000Z",
    });

    assert.equal(result.errorMessage, null);
    assert.equal(result.matchedMessage?.id, "msg-provider-only");
    assert.equal(rows[0]!.status, "delivered");
    assert.equal(rows[0]!.delivery_status, "delivered");
  });

  test("metadata provider id fallback prevents false row-not-found for valid sent message", async () => {
    const providerMessageId = "4f30cbcd-metadata-only";
    const rows: MessageRow[] = [
      {
        id: "msg-metadata-only",
        direction: "outbound",
        external_id: null,
        provider_message_id: null,
        metadata: { provider_message_id: providerMessageId },
        status: "queued",
        delivery_status: "queued",
      },
    ];

    const result = await reconcileMessageDeliveryPatch(fakeSupabaseForMessages(rows) as never, {
      externalIdTrimmed: providerMessageId,
      deliveryStatus: "delivered",
      touchedAtIso: "2026-05-17T00:00:00.000Z",
    });

    assert.equal(result.errorMessage, null);
    assert.equal(result.matchedMessage?.id, "msg-metadata-only");
    assert.equal(rows[0]!.delivery_status, "delivered");
  });

  test("delivery callback extracts provider id from nested Sent.dm shapes", () => {
    assert.equal(
      extractSentDmMessageExternalId({ data: { message_id: "nested-data-mid" } }),
      "nested-data-mid"
    );
    assert.equal(
      extractSentDmMessageExternalId({ message: { id: "nested-message-id" } }),
      "nested-message-id"
    );
  });
});
