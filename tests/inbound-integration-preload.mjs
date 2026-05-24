import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function registerMock(relPath, options) {
  const absPath = join(root, relPath);
  mock.module(pathToFileURL(absPath).href, options);
}

const testBusinessConfig = {
  id: "00000000-0000-4000-8000-000000000099",
  slug: "primetime-golf",
  name: "Primetime Golf",
  websiteDomain: "primetimegolf.com",
  assistantName: "Primetime Assistant",
  messagingProvider: "sentdm",
  smsFromNumber: "+15559876543",
  autoSendEnabled: false,
  minConfidence: 0.55,
  maxSmsLength: 480,
  supportResponse: "Thanks — a team member will reply soon.",
  afterHoursResponse: "We're closed right now; we'll follow up tomorrow.",
  menuResponse: "Reply 1 for lessons, 2 for events.",
  optOutResponse: "You're unsubscribed.",
  aiSourceOfTruth: "Primetime Golf indoor facility.",
  optInResponse: null,
  businessTimezone: "America/Los_Angeles",
  supportWeekdays: [1, 2, 3, 4, 5],
  supportOpenLocal: "09:00",
  supportCloseLocal: "21:00",
  riskyInboundTerms: [],
  riskyResponseTerms: [],
};

globalThis.__closeosGenerateAiDecisionCalls = 0;

registerMock("lib/business-messaging-config.ts", {
  namedExports: {
    resolveBusinessMessagingConfigFromDb: async () => testBusinessConfig,
    messagingAutoSendPolicy: (config) => ({
      enabled: config.autoSendEnabled,
      minConfidence: config.minConfidence,
      maxSmsLength: config.maxSmsLength,
      riskyInboundTerms: config.riskyInboundTerms,
      riskyResponseTerms: config.riskyResponseTerms,
    }),
    getHelpResponseForConfig: () => "Reply HELP for assistance.",
  },
});

registerMock("lib/agent/business-rules-gate.ts", {
  namedExports: {
    businessRulesGate: () => ({
      shouldContinueToAI: true,
      shouldSend: false,
      shouldEscalate: false,
      reason: "test_allow",
      blockImmediateOutbound: false,
    }),
  },
});

registerMock("lib/agent/conversation-summary.ts", {
  namedExports: {
    maybeUpdateConversationSummary: async () => ({ updated: false }),
  },
});

registerMock("lib/sentdm/inbound-sms-booking-phase.ts", {
  namedExports: {
    runInboundSmsBookingAugmentationPhase: async () => ({
      playbook: "general",
      conversationHistory: [],
      smsBookingFlow: { kind: "none", debug: { reason: "integration_test" } },
    }),
    loadSmsConversationHistoryAscending: async () => [],
  },
});

registerMock("lib/sentdm/send-message.ts", {
  namedExports: {
    sendSentDmMessage: async () => {
      throw new Error("sendSentDmMessage must not run when auto_send is disabled");
    },
  },
});

registerMock("lib/ai/conversation-reply-core.ts", {
  namedExports: {
    generateAiDecision: async () => {
      globalThis.__closeosGenerateAiDecisionCalls =
        (globalThis.__closeosGenerateAiDecisionCalls ?? 0) + 1;
      return {
        intent: "membership_inquiry",
        confidence: 0.92,
        risk_level: "low",
        can_auto_send: false,
        escalation_required: false,
        escalation_reason: null,
        reply_text: "We offer weekday and full-access memberships — want a quick tour?",
      };
    },
    buildFallbackDecision: (err) => ({
      intent: "unknown",
      confidence: 0.2,
      risk_level: "high",
      can_auto_send: false,
      escalation_required: true,
      escalation_reason: err,
      reply_text: "Fallback reply",
    }),
    applyMisunderstoodRouting: (d) => d,
    getAutoSendDecision: () => ({ shouldAutoSend: false, reason: "auto_send_disabled" }),
    getNextConversationState: () => "qualifying",
    decidePlaybook: () => "general",
    AI_RESPONSE_MODEL: "gpt-4o-mini",
    PENDING_SEND_STATUS: "pending_send",
    DEFAULT_ESCALATION_REPLY: "Escalation",
  },
});
