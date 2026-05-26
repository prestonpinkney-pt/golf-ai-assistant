/**
 * Full inbound conversational path for allowlisted live-agent SMS (mocked provider).
 * Run: npm run test:live-agent-sms
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";

import { createInboundLoopMockSupabase } from "./test/inbound-loop-mock-supabase";

declare global {
  // eslint-disable-next-line no-var
  var __closeosLiveAgentSendAttempts:
    | Array<{ to: string; message: string }>
    | undefined;
  // eslint-disable-next-line no-var
  var __closeosGenerateAiDecisionCalls: number | undefined;
}

const TEST_PHONE = "+15103756639";
const INBOUND_TEXT = "Are there available times on Sunday?";

type InboundLoopModule = typeof import("./inbound-loop");

let runSentDmInboundConversationLoop: InboundLoopModule["runSentDmInboundConversationLoop"];

function envelopeForPhone(text: string) {
  return {
    sub_type: "message.received",
    field: "message",
    payload: {
      from: TEST_PHONE,
      to: "+15559876543",
      text,
      channel: "sms",
    },
    timestamp: new Date().toISOString(),
  };
}

before(async () => {
  const inboundLoop = await import("./inbound-loop");
  runSentDmInboundConversationLoop = inboundLoop.runSentDmInboundConversationLoop;
});

describe("live agent SMS conversational path", () => {
  beforeEach(() => {
    globalThis.__closeosLiveAgentSendAttempts = [];
    globalThis.__closeosGenerateAiDecisionCalls = 0;
    process.env.OPENAI_API_KEY = "test_openai_key_stub_unit";
    process.env.CLOSEOS_QUIET_HOURS_ENABLED = "false";
    process.env.CLOSEOS_LIVE_AGENT_TEST_MODE = "true";
    process.env.CLOSEOS_TEST_SMS_ALLOWLIST = TEST_PHONE;
    process.env.SENTDM_API_KEY = "test-key";
    process.env.SENTDM_SEND_MODE = "direct_text";
  });

  test("allowlisted Sunday availability inquiry sends safe qualification reply", async () => {
    const supabase = createInboundLoopMockSupabase();
    const externalId = `live-agent-${Date.now()}`;

    const result = await runSentDmInboundConversationLoop({
      supabase,
      rawPayload: envelopeForPhone(INBOUND_TEXT),
      externalId,
      ingestSource: "sentdm_webhook",
    });

    assert.equal(result.ok, true);
    assert.equal(globalThis.__closeosGenerateAiDecisionCalls, 1);

    const inbound = supabase.__tables.messages.find(
      (m) => m.direction === "inbound" && m.external_id === externalId
    );
    assert.ok(inbound, "expected inbound message saved");

    const outbound = supabase.__tables.messages.find(
      (m) =>
        m.direction === "outbound" &&
        m.ai_generated === true &&
        m.conversation_id === inbound?.conversation_id
    );
    assert.ok(outbound, "expected AI outbound message saved");
    assert.match(String(outbound?.message_text ?? ""), /how many players/i);

    const meta = (outbound?.metadata ?? {}) as Record<string, unknown>;
    assert.equal(meta.should_send_model, true);
    assert.notEqual(meta.provider_send_blocker, "not_allowlisted");

    const attempts = globalThis.__closeosLiveAgentSendAttempts ?? [];
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.to, TEST_PHONE);
    assert.match(String(attempts[0]?.message ?? ""), /how many players/i);

    assert.equal(outbound?.status, "queued");
    assert.equal(outbound?.delivery_status, "queued");
  });

  test("non-allowlisted phone skips provider send with not_allowlisted", async () => {
    process.env.CLOSEOS_TEST_SMS_ALLOWLIST = "+15559998888";
    const supabase = createInboundLoopMockSupabase();

    const result = await runSentDmInboundConversationLoop({
      supabase,
      rawPayload: envelopeForPhone(INBOUND_TEXT),
      externalId: `live-agent-blocked-${Date.now()}`,
      ingestSource: "sentdm_webhook",
    });

    assert.equal(result.ok, true);
    const outbound = supabase.__tables.messages.find(
      (m) => m.direction === "outbound" && m.ai_generated === true
    );
    const meta = (outbound?.metadata ?? {}) as Record<string, unknown>;
    assert.equal(meta.provider_send_blocker, "not_allowlisted");
    assert.equal((globalThis.__closeosLiveAgentSendAttempts ?? []).length, 0);
  });
});
