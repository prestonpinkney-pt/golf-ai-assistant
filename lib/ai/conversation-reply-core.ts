import OpenAI from "openai";
import { AI_AUTO_SEND_POLICY } from "@/app/api/config/ai-source-of-truth";
import {
  buildInboundSmsAgentSystemPrompt,
  SMS_AGENT_HANDOFF_REPLY,
  SMS_AGENT_MISUNDERSTOOD_REPLY_TEMPLATE,
} from "@/lib/ai/sms-agent-system-prompt";

import { isLikelyE164Phone } from "@/lib/ai/phone-e164";

export { isLikelyE164Phone };

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export const AI_RESPONSE_MODEL = "gpt-4o-mini";
export const PENDING_SEND_STATUS = "pending_send";

export const DEFAULT_ESCALATION_REPLY = SMS_AGENT_HANDOFF_REPLY;

export type ConversationHistoryMessage = {
  direction: string | null;
  channel: string | null;
  message_text: string | null;
  status: string | null;
  created_at: string | null;
};

export type RiskLevel = "low" | "medium" | "high";

export type AiResponseDecision = {
  intent: string;
  confidence: number;
  risk_level: RiskLevel;
  can_auto_send: boolean;
  escalation_required: boolean;
  escalation_reason: string | null;
  reply_text: string;
};

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function decidePlaybook(message: string): string {
  const text = (message || "").toLowerCase();

  if (
    text.includes("simulator") ||
    text.includes("sim bay") ||
    text.includes("bay time") ||
    text.includes("trackman") ||
    text.includes("foresight") ||
    text.includes(" gcquad") ||
    text.includes("gc quad") ||
    text.includes("bay booking") ||
    (text.includes(" sim ") && !text.includes("similar")) ||
    /\bsim\b/.test(text)
  ) {
    return "simulator";
  }

  if (
    text.includes("lesson") ||
    text.includes("swing") ||
    text.includes("junior") ||
    text.includes("30 min") ||
    text.includes("1 hour")
  ) {
    return "lesson";
  }

  if (
    text.includes("event") ||
    text.includes("party") ||
    text.includes("birthday") ||
    text.includes("corporate") ||
    text.includes("group")
  ) {
    return "event";
  }

  if (
    text.includes("membership") ||
    text.includes("member") ||
    text.includes("monthly")
  ) {
    return "membership";
  }

  return "general";
}

export function formatConversationHistory(messages: ConversationHistoryMessage[]) {
  if (messages.length === 0) return "No prior messages in this thread.";

  return messages
    .map((message) => {
      const direction = (message.direction || "").toLowerCase();
      const speaker =
        direction === "inbound" || direction === "incoming" ?
          "Customer"
        : direction === "outbound" || direction === "outgoing" ?
          "You"
        : "Message";
      const text = message.message_text?.trim() || "(empty)";
      return `${speaker}: ${text}`;
    })
    .join("\n");
}

export async function generateAiDecision(input: {
  inboundText: string;
  playbook: string;
  currentState: string;
  contactName?: string | null;
  channel?: string | null;
  businessName: string;
  assistantName: string;
  shouldDiscloseAutomation: boolean;
  sourceOfTruth: string;
  conversationHistory: ConversationHistoryMessage[];
  /** Runtime SMS booking / concierge notes merged into prompt (Whoosh appendix, escalations). */
  runtimeAppendix?: string | null;
}): Promise<AiResponseDecision> {
  const completion = await openai.chat.completions.create({
    model: AI_RESPONSE_MODEL,
    temperature: 0.78,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: buildInboundSmsAgentSystemPrompt({
          businessName: input.businessName,
          assistantName: input.assistantName,
          sourceOfTruth: input.sourceOfTruth,
        }),
      },
      {
        role: "user",
        content: `
Business: ${input.businessName}
Assistant name: ${input.assistantName}
Contact name: ${input.contactName?.trim() || "Unknown"}
Channel: ${input.channel || "sms"}
Conversation state: ${input.currentState}
First automated reply requiring disclosure: ${input.shouldDiscloseAutomation ? "yes" : "no"}
Detected playbook: ${input.playbook}
Conversation history:
${formatConversationHistory(input.conversationHistory)}

${typeof input.runtimeAppendix === "string" && input.runtimeAppendix.trim() ? `\nRuntime context:\n${input.runtimeAppendix.trim()}\n` : ""}

Customer message: ${input.inboundText}
        `.trim(),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim();
  if (!raw) {
    throw new Error("OpenAI returned an empty response");
  }

  return normalizeAiDecision(JSON.parse(raw));
}

function includesAnyTerm(text: string, terms: readonly string[]) {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

export function getMetadataString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export { withAutomationDisclosure } from "@/lib/messaging/with-automation-disclosure";

export function normalizeAiDecision(value: unknown): AiResponseDecision {
  const parsed = (value ?? {}) as Partial<AiResponseDecision>;
  const riskLevel: RiskLevel =
    parsed.risk_level === "low" ||
    parsed.risk_level === "medium" ||
    parsed.risk_level === "high"
      ? parsed.risk_level
      : "high";
  const confidence = Number(parsed.confidence);
  const boundedConfidence = Number.isFinite(confidence)
    ? Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence))
    : 0;
  const replyText =
    typeof parsed.reply_text === "string" && parsed.reply_text.trim()
      ? parsed.reply_text.trim()
      : DEFAULT_ESCALATION_REPLY;
  const escalationRequired =
    parsed.escalation_required === true || riskLevel !== "low";

  return {
    intent:
      typeof parsed.intent === "string" && parsed.intent.trim()
        ? parsed.intent.trim()
        : "unknown",
    confidence: boundedConfidence,
    risk_level: riskLevel,
    can_auto_send: parsed.can_auto_send === true,
    escalation_required: escalationRequired,
    escalation_reason:
      typeof parsed.escalation_reason === "string" && parsed.escalation_reason.trim()
        ? parsed.escalation_reason.trim()
        : escalationRequired
          ? "AI marked this message for human review."
          : null,
    reply_text: replyText,
  };
}

export function buildFallbackDecision(reason: string): AiResponseDecision {
  return {
    intent: "unknown",
    confidence: 0,
    risk_level: "high",
    can_auto_send: false,
    escalation_required: true,
    escalation_reason: reason,
    reply_text: DEFAULT_ESCALATION_REPLY,
  };
}

const UNKNOWN_INTENT = "unknown";

/**
 * When the model is unsure, force Apple-style handoff copy and block auto-send.
 */
export function applyMisunderstoodRouting(
  decision: AiResponseDecision,
  businessName: string,
  confidenceFloor = 0.42
): AiResponseDecision {
  const intentLower = decision.intent.trim().toLowerCase();
  const isUnknownIntent = intentLower === UNKNOWN_INTENT;
  const lowConfidence = decision.confidence < confidenceFloor;

  if (!isUnknownIntent && !lowConfidence) {
    return decision;
  }

  const routing = SMS_AGENT_MISUNDERSTOOD_REPLY_TEMPLATE.replace(
    "{business}",
    businessName.trim() || "the team"
  );

  return {
    ...decision,
    intent: isUnknownIntent ? UNKNOWN_INTENT : decision.intent,
    reply_text: routing,
    escalation_required: true,
    can_auto_send: false,
    risk_level: "high",
    escalation_reason:
      decision.escalation_reason?.trim() ||
      (isUnknownIntent
        ? "Assistant could not determine customer intent."
        : "Assistant confidence was below the safe threshold for automation."),
  };
}

export function getAutoSendDecision(input: {
  inboundText: string;
  decision: AiResponseDecision;
  channel?: string | null;
  phone?: unknown;
  /** When true, skip substring checks against riskyResponseTerms (e.g. vetted deterministic Whoosh confirmations). */
  bypassRiskyResponseTerms?: boolean;
  policy?: {
    enabled: boolean;
    minConfidence: number;
    maxSmsLength: number;
    riskyInboundTerms?: readonly string[];
    riskyResponseTerms?: readonly string[];
  };
}): { shouldAutoSend: boolean; reason: string } {
  const policy = input.policy ?? AI_AUTO_SEND_POLICY;
  const inboundTerms = policy.riskyInboundTerms ?? AI_AUTO_SEND_POLICY.riskyInboundTerms;
  const responseTerms = policy.riskyResponseTerms ?? AI_AUTO_SEND_POLICY.riskyResponseTerms;

  if (!policy.enabled) {
    return { shouldAutoSend: false, reason: "auto_send_disabled" };
  }

  if (input.channel !== "sms") {
    return { shouldAutoSend: false, reason: "not_sms_channel" };
  }

  if (!isLikelyE164Phone(input.phone)) {
    return { shouldAutoSend: false, reason: "missing_valid_phone" };
  }

  if (input.decision.escalation_required) {
    return { shouldAutoSend: false, reason: "ai_escalation_required" };
  }

  if (!input.decision.can_auto_send) {
    return { shouldAutoSend: false, reason: "ai_auto_send_denied" };
  }

  if (input.decision.confidence < policy.minConfidence) {
    return { shouldAutoSend: false, reason: "low_ai_confidence" };
  }

  if (input.decision.risk_level !== "low") {
    return { shouldAutoSend: false, reason: "non_low_risk_level" };
  }

  if (input.decision.reply_text.length > policy.maxSmsLength) {
    return { shouldAutoSend: false, reason: "response_too_long" };
  }

  if (includesAnyTerm(input.inboundText, inboundTerms)) {
    return { shouldAutoSend: false, reason: "risky_inbound_topic" };
  }

  if (!input.bypassRiskyResponseTerms && includesAnyTerm(input.decision.reply_text, responseTerms)) {
    return { shouldAutoSend: false, reason: "risky_response_claim" };
  }

  return { shouldAutoSend: true, reason: "low_risk_sms_reply" };
}

export function getNextConversationState(
  currentState: string,
  playbook: string,
  inboundText: string
): string {
  const text = (inboundText || "").toLowerCase();

  if (currentState === "new_inquiry") {
    return "qualifying";
  }

  if (currentState === "qualifying") {
    if (
      playbook === "lesson" &&
      (text.includes("30") ||
        text.includes("1 hour") ||
        text.includes("hour") ||
        text.includes("this week") ||
        text.includes("book"))
    ) {
      return "ready_to_book";
    }

    if (
      playbook === "simulator" &&
      (text.includes("player") ||
        text.includes("players") ||
        text.includes("9") ||
        text.includes("18") ||
        text.includes("practice") ||
        text.includes("friday") ||
        text.includes("saturday") ||
        text.includes("sunday") ||
        text.includes("book"))
    ) {
      return "ready_to_book";
    }

    if (
      playbook === "event" &&
      (text.includes("birthday") ||
        text.includes("corporate") ||
        text.includes("party") ||
        text.includes("people") ||
        text.includes("date"))
    ) {
      return "ready_to_book";
    }

    if (
      playbook === "membership" &&
      (text.includes("membership") ||
        text.includes("practice") ||
        text.includes("play") ||
        text.includes("weekly"))
    ) {
      return "ready_to_book";
    }
  }

  return currentState;
}
