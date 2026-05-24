import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { businessRulesGate } from "./business-rules-gate";
import type { BusinessMessagingConfig } from "@/lib/business-messaging-config";

function baseConfig(): BusinessMessagingConfig {
  return {
    id: "biz-1",
    slug: "primetime-golf",
    name: "Primetime Golf",
    websiteDomain: "primetime.golf",
    assistantName: "Primetime Assistant",
    messagingProvider: "sentdm",
    smsFromNumber: "+15551234567",
    autoSendEnabled: true,
    minConfidence: 0.75,
    maxSmsLength: 600,
    supportResponse: "Our team will follow up shortly.",
    afterHoursResponse: "We are closed — we will reply during business hours.",
    menuResponse: "Reply HELP for help.",
    optOutResponse: "You are opted out.",
    aiSourceOfTruth: "Test facility",
    optInResponse: null,
    businessTimezone: "America/Los_Angeles",
    supportWeekdays: [1, 2, 3, 4, 5],
    supportOpenLocal: "09:00",
    supportCloseLocal: "17:00",
    riskyInboundTerms: ["custom price"],
    riskyResponseTerms: [],
  };
}

describe("businessRulesGate production QA", () => {
  test("blocks when contact already opted out", () => {
    const gate = businessRulesGate({
      inboundText: "hello",
      contact: { sms_opt_out: true },
      conversation: {},
      config: baseConfig(),
      now: new Date(),
      optOutPreviously: true,
    });
    assert.equal(gate.shouldContinueToAI, false);
    assert.equal(gate.blockImmediateOutbound, true);
    assert.equal(gate.reason, "contact_already_opted_out");
  });

  test("escalates high-risk inbound without opening links", () => {
    const gate = businessRulesGate({
      inboundText: "I want a refund now",
      contact: {},
      conversation: {},
      config: baseConfig(),
      now: new Date(),
      optOutPreviously: false,
    });
    assert.equal(gate.shouldEscalate, true);
    assert.equal(gate.reason, "high_risk_escalation");
    assert.equal(typeof gate.replyText, "string");
  });

  test("link-only inbound does not continue to AI or send", () => {
    const gate = businessRulesGate({
      inboundText: "https://example.com/phish",
      contact: {},
      conversation: {},
      config: baseConfig(),
      now: new Date(),
      optOutPreviously: false,
    });
    assert.equal(gate.shouldContinueToAI, false);
    assert.equal(gate.shouldSend, false);
    assert.equal(gate.blockImmediateOutbound, true);
    assert.equal(gate.reason, "link_only_no_usable_text");
  });

  test("human takeover blocks automation", () => {
    const gate = businessRulesGate({
      inboundText: "any message",
      contact: {},
      conversation: { human_takeover: true },
      config: baseConfig(),
      now: new Date(),
      optOutPreviously: false,
    });
    assert.equal(gate.shouldContinueToAI, false);
    assert.equal(gate.shouldEscalate, true);
    assert.equal(gate.blockImmediateOutbound, true);
  });
});
