import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessMessagingConfig } from "@/lib/business-messaging-config";
import { messagingAutoSendPolicy } from "@/lib/business-messaging-config";
import {
  applyMisunderstoodRouting,
  buildFallbackDecision,
  decidePlaybook,
  generateAiDecision,
  getAutoSendDecision,
  getNextConversationState,
} from "@/lib/ai/conversation-reply-core";
import { loadSmsConversationHistoryAscending } from "@/lib/sentdm/inbound-sms-booking-phase";

export type AgentIntent =
  | "lesson"
  | "event"
  | "membership"
  | "booking"
  | "pricing"
  | "support"
  | "stop"
  | "unknown";

export type GenerateReplyResult = {
  replyText: string;
  intent: AgentIntent;
  conversationStage: string;
  shouldSend: boolean;
  shouldEscalate: boolean;
  confidence: number;
};

const ALLOWED_INTENTS = new Set<AgentIntent>([
  "lesson",
  "event",
  "membership",
  "booking",
  "pricing",
  "support",
  "stop",
  "unknown",
]);

function normalizeIntent(raw: string | undefined): AgentIntent {
  const value = (raw || "unknown").toLowerCase().trim();
  return ALLOWED_INTENTS.has(value as AgentIntent) ? (value as AgentIntent) : "unknown";
}

/**
 * @deprecated Prefer `generateAiDecision` from `@/lib/ai/conversation-reply-core`.
 * Thin adapter for legacy callers — no standalone OpenAI prompt stack.
 */
export async function generateReply(input: {
  supabase: SupabaseClient;
  conversationId: string;
  inboundText: string;
  contact: Record<string, unknown>;
  qualificationProfile: Record<string, unknown> | null;
  config: BusinessMessagingConfig;
  latestInboundMeta?: Record<string, unknown>;
  conversationSummary?: string | null;
  runtimeAppendix?: string | null;
}): Promise<GenerateReplyResult> {
  void input.qualificationProfile;
  void input.latestInboundMeta;

  if (!process.env.OPENAI_API_KEY?.trim()) {
    return {
      replyText:
        "Thanks for texting Primetime Golf. A staff member will follow up shortly.",
      intent: "unknown",
      conversationStage: "escalated_no_model",
      shouldSend: false,
      shouldEscalate: true,
      confidence: 0.2,
    };
  }

  const conversationHistory = await loadSmsConversationHistoryAscending(
    input.supabase,
    input.conversationId
  );
  const playbook = decidePlaybook(input.inboundText);
  const currentState = "new_inquiry";
  const shouldDiscloseAutomation = !conversationHistory.some(
    (message) => message.direction === "outbound"
  );

  const runtimeAppendixParts: string[] = [];
  if (input.conversationSummary?.trim()) {
    runtimeAppendixParts.push(
      "Long-running conversation summary (soft background only; inbound_text and recent messages win on conflict):\n" +
        input.conversationSummary.trim()
    );
  }
  if (input.runtimeAppendix?.trim()) {
    runtimeAppendixParts.push(input.runtimeAppendix.trim());
  }
  const runtimeAppendix =
    runtimeAppendixParts.length > 0 ? runtimeAppendixParts.join("\n\n") : null;

  const aiDecisionRaw = await generateAiDecision({
    inboundText: input.inboundText,
    playbook,
    currentState,
    contactName: typeof input.contact?.name === "string" ? input.contact.name : null,
    channel: "sms",
    businessName: input.config.name,
    assistantName: input.config.assistantName,
    shouldDiscloseAutomation,
    sourceOfTruth: input.config.aiSourceOfTruth,
    conversationHistory,
    runtimeAppendix,
  }).catch((error: unknown) =>
    buildFallbackDecision(
      error instanceof Error ? error.message : "AI response generation failed"
    )
  );

  const aiDecision = applyMisunderstoodRouting(
    aiDecisionRaw,
    input.config.name,
    Math.min(input.config.minConfidence, 0.42)
  );

  const autoSendDecision = getAutoSendDecision({
    inboundText: input.inboundText,
    decision: aiDecision,
    channel: "sms",
    phone: input.contact?.phone,
    policy: messagingAutoSendPolicy(input.config),
  });

  const wantsSend =
    autoSendDecision.shouldAutoSend && input.contact?.sms_opt_out !== true;

  return {
    replyText: aiDecision.reply_text.slice(0, input.config.maxSmsLength),
    intent: normalizeIntent(aiDecision.intent),
    conversationStage: getNextConversationState(
      currentState,
      playbook,
      input.inboundText
    ),
    shouldSend: wantsSend,
    shouldEscalate: !autoSendDecision.shouldAutoSend,
    confidence: aiDecision.confidence,
  };
}
