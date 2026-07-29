import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { sendMessage } from "@/lib/send-message";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SENTDM_API_KEY;
  delete process.env.SENT_API_KEY;
  delete process.env.SENT_DM_API_KEY;
  delete process.env.SENT_DM_TEMPLATE_ID;
});

describe("sendMessage Sent.dm v3 response parsing", () => {
  test("persists provider message_id from documented data.recipients envelope", async () => {
    process.env.SENTDM_API_KEY = "test-key";
    const mid = "msg_recipients_abc123";

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            status: "QUEUED",
            recipients: [
              {
                message_id: mid,
                to: "+14155551234",
                channel: "sms",
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await sendMessage({
      channel: "sms",
      to: "+14155551234",
      message: "Operator reply",
      name: "Alex",
    });

    assert.equal(result.success, true);
    assert.equal(result.provider, "sentdm");
    assert.equal(result.external_id, mid);
    assert.equal(result.status, "QUEUED");
  });

  test("rejects HTTP 200 bodies with success:false", async () => {
    process.env.SENTDM_API_KEY = "test-key";

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: "invalid_template",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    await assert.rejects(
      () =>
        sendMessage({
          channel: "sms",
          to: "+14155551234",
          message: "Should fail",
        }),
      /Sent\.dm send rejected/
    );
  });
});
