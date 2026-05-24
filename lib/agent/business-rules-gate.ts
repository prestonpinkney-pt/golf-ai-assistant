import "server-only";

import type { BusinessMessagingConfig } from "@/lib/business-messaging-config";
import { isInboundQuietHoursActive } from "@/lib/messaging/quiet-hours";

export type BusinessRulesGateResult = {
  shouldContinueToAI: boolean;
  shouldSend: boolean;
  replyText?: string;
  shouldEscalate: boolean;
  escalationReason?: string;
  reason: string;
  /**
   * When true (e.g. quiet-hours defer policy), inbound-loop persists AI/gate drafts
   * but must not call Sent.dm for this turn.
   */
  blockImmediateOutbound?: boolean;
};

/** When quiet-hours window is active, defer outbound SMS but still draft via AI unless explicitly disabled. */
function quietHoursDeferOutboundEnabled(): boolean {
  if (!isInboundQuietHoursActive()) return false;
  const raw =
    process.env.CLOSEOS_QUIET_HOURS_DEFER_OUTBOUND_SEND?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") {
    return false;
  }
  return true;
}

const LINK_HTTP = /\bhttps?:\/\/[^\s]+/i;
const LINK_WWW = /\bwww\.[^\s]+\b/i;

function stripUrls(text: string): string {
  return text
    .replace(/\bhttps?:\/\/[^\s]+/gi, " ")
    .replace(/\bwww\.[^\s]+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasLikelyLink(text: string): boolean {
  return LINK_HTTP.test(text) || LINK_WWW.test(text);
}

const DEFAULT_HIGH_RISK = [
  "refund",
  "lawsuit",
  "attorney",
  "lawyer",
  "chargeback",
  "complaint",
  "manager",
  "bbb",
];

function matchesHighRisk(
  text: string,
  extraTerms: readonly string[]
): boolean {
  const lowered = text.toLowerCase();
  const terms = [...DEFAULT_HIGH_RISK, ...extraTerms];
  return terms.some(
    (w) => w.trim().length > 0 && lowered.includes(w.trim().toLowerCase())
  );
}

export function businessRulesGate(input: {
  inboundText: string;
  contact: Record<string, unknown>;
  conversation: Record<string, unknown>;
  config: BusinessMessagingConfig;
  now: Date;
  /** True when sms_opt_out is already set before this message handling. */
  optOutPreviously: boolean;
}): BusinessRulesGateResult {
  const { inboundText, contact, conversation, config, optOutPreviously } =
    input;

  void input.now;

  if (optOutPreviously || contact.sms_opt_out === true) {
    return {
      shouldContinueToAI: false,
      shouldSend: false,
      shouldEscalate: false,
      reason: "contact_already_opted_out",
      blockImmediateOutbound: true,
    };
  }

  if (conversation.human_takeover === true) {
    return {
      shouldContinueToAI: false,
      shouldSend: false,
      shouldEscalate: true,
      escalationReason:
        "Conversation is in human takeover; automation replies are disabled.",
      reason: "human_takeover",
      blockImmediateOutbound: true,
    };
  }

  if (conversation.automation_enabled === false) {
    return {
      shouldContinueToAI: false,
      shouldSend: false,
      shouldEscalate: true,
      escalationReason:
        "Automation is disabled on this conversation (automation_enabled = false).",
      reason: "automation_disabled",
      blockImmediateOutbound: true,
    };
  }

  if (matchesHighRisk(inboundText, config.riskyInboundTerms)) {
    const handoff =
      config.supportResponse?.trim()?.length ?
        config.supportResponse.trim().slice(0, config.maxSmsLength)
      : "Thanks — I’m escalating this to our team now and someone will reach out.";
    return {
      shouldContinueToAI: false,
      shouldSend: true,
      replyText: handoff,
      shouldEscalate: true,
      escalationReason:
        "Inbound matched high‑risk phrases (billing/legal/complaint/manager/etc.).",
      reason: "high_risk_escalation",
      blockImmediateOutbound: false,
    };
  }

  const linkPresent = hasLikelyLink(inboundText);
  const usableAfterStrip = stripUrls(inboundText);
  if (linkPresent && !usableAfterStrip.length) {
    return {
      shouldContinueToAI: false,
      shouldSend: false,
      shouldEscalate: false,
      reason: "link_only_no_usable_text",
      blockImmediateOutbound: true,
    };
  }

  const quietActive = isInboundQuietHoursActive();
  if (quietActive && quietHoursDeferOutboundEnabled()) {
    return {
      shouldContinueToAI: true,
      shouldSend: false,
      shouldEscalate: false,
      reason:
        "quiet_hours_defer_immediate_send: AI may draft replies; outbound SMS deferred.",
      blockImmediateOutbound: true,
    };
  }

  if (quietActive && !quietHoursDeferOutboundEnabled()) {
    return {
      shouldContinueToAI: false,
      shouldSend: false,
      shouldEscalate: false,
      reason: "quiet_hours_block_ai_requires_no_defer",
      blockImmediateOutbound: true,
    };
  }

  return {
    shouldContinueToAI: true,
    shouldSend: true,
    shouldEscalate: false,
    reason: "continue_automation_ok",
    blockImmediateOutbound: false,
  };
}
