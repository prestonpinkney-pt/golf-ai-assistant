import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AI_AUTO_SEND_POLICY } from "@/app/api/config/ai-source-of-truth";
import {
  getAutoSendDecision,
  type AiResponseDecision,
} from "@/lib/ai/conversation-reply-core";
import {
  applySafeBookingQualificationNormalization,
  inboundRequestsExplicitBookingConfirmation,
  isSafeBookingQualificationReply,
} from "@/lib/ai/safe-booking-qualification-reply";

const E164 = "+15551234567";

function mediumEscalatedDecision(
  replyText: string,
  intent = "booking_inquiry"
): AiResponseDecision {
  return {
    intent,
    confidence: 0.88,
    risk_level: "medium",
    can_auto_send: false,
    escalation_required: true,
    escalation_reason: "Model flagged medium risk.",
    reply_text: replyText,
  };
}

function normalizeAndAutoSend(input: {
  inboundText: string;
  replyText: string;
  playbook?: string;
  intent?: string;
}): { safe: boolean; shouldAutoSend: boolean; reason: string } {
  const playbook = input.playbook ?? "general";
  const intent = input.intent ?? "booking_inquiry";
  const safe = isSafeBookingQualificationReply({
    inboundText: input.inboundText,
    replyText: input.replyText,
    intent,
    playbook,
  });
  const normalized = applySafeBookingQualificationNormalization(
    mediumEscalatedDecision(input.replyText, intent),
    {
      inboundText: input.inboundText,
      playbook,
      intent,
    }
  );
  const auto = getAutoSendDecision({
    inboundText: input.inboundText,
    decision: normalized,
    channel: "sms",
    phone: E164,
    policy: { ...AI_AUTO_SEND_POLICY, enabled: true, minConfidence: 0.5 },
  });
  return { safe, shouldAutoSend: auto.shouldAutoSend, reason: auto.reason };
}

describe("isSafeBookingQualificationReply", () => {
  test("Sunday availability + player count question can auto-send after normalization", () => {
    const inbound = "Are there available times on Sunday?";
    const reply = "Got it. How many players total?";
    const result = normalizeAndAutoSend({ inboundText: inbound, replyText: reply });
    assert.equal(result.safe, true);
    assert.equal(result.shouldAutoSend, true);
    assert.equal(result.reason, "low_risk_sms_reply");
  });

  test("Sunday availability + model escalation reply is replaced with player count question", () => {
    const inbound = "Are there available times on Sunday?";
    const escalationReply =
      "Got it — I'm looping in someone from Primetime Golf so we don't steer you wrong. They'll follow up directly.";
    const normalized = applySafeBookingQualificationNormalization(
      mediumEscalatedDecision(escalationReply, "availability_inquiry"),
      { inboundText: inbound, playbook: "general", intent: "availability_inquiry" }
    );
    assert.match(normalized.reply_text, /how many players/i);
    assert.equal(normalized.risk_level, "low");
    assert.equal(normalized.escalation_required, false);
    assert.equal(normalized.can_auto_send, true);
    const auto = getAutoSendDecision({
      inboundText: inbound,
      decision: normalized,
      channel: "sms",
      phone: E164,
      policy: { ...AI_AUTO_SEND_POLICY, enabled: true, minConfidence: 0.5 },
    });
    assert.equal(auto.shouldAutoSend, true);
  });

  test("simulator time this week + qualifying question can auto-send", () => {
    const result = normalizeAndAutoSend({
      inboundText: "Do you have simulator time this week?",
      replyText: "Nice — practice or a full round?",
      playbook: "simulator",
      intent: "availability",
    });
    assert.equal(result.safe, true);
    assert.equal(result.shouldAutoSend, true);
  });

  test("explicit confirm-for-slot inbound is not safe qualification", () => {
    const inbound = "Can you confirm me for Sunday at 2?";
    assert.equal(inboundRequestsExplicitBookingConfirmation(inbound), true);
    const safe = isSafeBookingQualificationReply({
      inboundText: inbound,
      replyText: "How many players?",
      intent: "booking",
      playbook: "simulator",
    });
    assert.equal(safe, false);
    const result = normalizeAndAutoSend({
      inboundText: inbound,
      replyText: "How many players?",
      playbook: "simulator",
    });
    assert.equal(result.shouldAutoSend, false);
  });

  test("refund request inbound is not safe qualification", () => {
    const result = normalizeAndAutoSend({
      inboundText: "I want a refund for Sunday",
      replyText: "How many players?",
    });
    assert.equal(result.safe, false);
    assert.equal(result.shouldAutoSend, false);
  });

  test("cancel membership inbound is not safe qualification", () => {
    const result = normalizeAndAutoSend({
      inboundText: "Cancel my membership",
      replyText: "How many players?",
    });
    assert.equal(result.safe, false);
    assert.equal(result.shouldAutoSend, false);
  });

  test("billing dispute inbound is not safe qualification", () => {
    const result = normalizeAndAutoSend({
      inboundText: "You charged me wrong",
      replyText: "How many players?",
    });
    assert.equal(result.safe, false);
    assert.equal(result.shouldAutoSend, false);
  });

  test("exact unverified time in reply blocks safe qualification", () => {
    const safe = isSafeBookingQualificationReply({
      inboundText: "Any simulator time Sunday?",
      replyText: "We have 2 PM open — how many players?",
      intent: "availability",
      playbook: "simulator",
    });
    assert.equal(safe, false);
    const result = normalizeAndAutoSend({
      inboundText: "Any simulator time Sunday?",
      replyText: "We have 2 PM open — how many players?",
      playbook: "simulator",
    });
    assert.equal(result.shouldAutoSend, false);
  });

  test("confirmation language in reply blocks safe qualification", () => {
    const safe = isSafeBookingQualificationReply({
      inboundText: "Any times Sunday?",
      replyText: "You're confirmed for Sunday afternoon.",
      intent: "booking",
      playbook: "simulator",
    });
    assert.equal(safe, false);
  });
});

describe("safe booking qualification vs carrier gates", () => {
  test("safe qualification does not bypass auto_send_disabled policy", () => {
    const normalized = applySafeBookingQualificationNormalization(
      mediumEscalatedDecision("Got it. How many players total?"),
      {
        inboundText: "Are there available times on Sunday?",
        playbook: "general",
        intent: "booking_inquiry",
      }
    );
    const auto = getAutoSendDecision({
      inboundText: "Are there available times on Sunday?",
      decision: normalized,
      channel: "sms",
      phone: E164,
      policy: { ...AI_AUTO_SEND_POLICY, enabled: false },
    });
    assert.equal(auto.shouldAutoSend, false);
    assert.equal(auto.reason, "auto_send_disabled");
  });
});

describe("Whoosh confirmation vs risky_response_claim", () => {
  const whooshConfirmedDecision: AiResponseDecision = {
    intent: "booking_flow_direct",
    confidence: 0.93,
    risk_level: "low",
    can_auto_send: true,
    escalation_required: false,
    escalation_reason: null,
    reply_text:
      "Confirmed for Mon Jun 4 6:30 PM (Primetime Golf — Downtown Oakland). Ref C-900",
  };

  test("Whoosh Confirmed-for copy is blocked without bypassRiskyResponseTerms", () => {
    const auto = getAutoSendDecision({
      inboundText: "1",
      decision: whooshConfirmedDecision,
      channel: "sms",
      phone: E164,
      policy: { ...AI_AUTO_SEND_POLICY, enabled: true, minConfidence: 0.5 },
    });
    assert.equal(auto.shouldAutoSend, false);
    assert.equal(auto.reason, "risky_response_claim");
  });

  test("Whoosh Confirmed-for copy auto-sends when bypassRiskyResponseTerms is set", () => {
    const auto = getAutoSendDecision({
      inboundText: "1",
      decision: whooshConfirmedDecision,
      channel: "sms",
      phone: E164,
      bypassRiskyResponseTerms: true,
      policy: { ...AI_AUTO_SEND_POLICY, enabled: true, minConfidence: 0.5 },
    });
    assert.equal(auto.shouldAutoSend, true);
    assert.equal(auto.reason, "low_risk_sms_reply");
  });
});
