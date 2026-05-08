import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { BUSINESS_NAME } from "@/app/api/config";
import {
  AI_AUTO_SEND_POLICY,
  AI_SOURCE_OF_TRUTH,
} from "@/app/api/config/ai-source-of-truth";
import { sendMessage } from "@/lib/send-message";
import {
  gateInternalOrBusinessUser,
  isInternalSecretAuthorizedRequest,
} from "../../lib/require-auth";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PENDING_SEND_STATUS = "pending_send";
const AI_RESPONSE_MODEL = "gpt-4o-mini";
const DEFAULT_ESCALATION_REPLY =
  "Thanks for reaching out. A team member will follow up shortly to help with this.";

type ConversationHistoryMessage = {
  direction: string | null;
  channel: string | null;
  message_text: string | null;
  status: string | null;
  created_at: string | null;
};

type RiskLevel = "low" | "medium" | "high";

type AiResponseDecision = {
  intent: string;
  confidence: number;
  risk_level: RiskLevel;
  can_auto_send: boolean;
  escalation_required: boolean;
  escalation_reason: string | null;
  reply_text: string;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function decidePlaybook(message: string): string {
  const text = (message || "").toLowerCase();

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

function formatConversationHistory(messages: ConversationHistoryMessage[]) {
  if (messages.length === 0) return "No prior conversation history.";

  return messages
    .map((message) => {
      const direction = message.direction || "unknown";
      const channel = message.channel || "unknown";
      const text = message.message_text?.trim() || "(empty message)";
      return `${direction} via ${channel}: ${text}`;
    })
    .join("\n");
}

async function generateAiDecision(input: {
  inboundText: string;
  playbook: string;
  currentState: string;
  contactName?: string | null;
  channel?: string | null;
  conversationHistory: ConversationHistoryMessage[];
}): Promise<AiResponseDecision> {
  const completion = await openai.chat.completions.create({
    model: AI_RESPONSE_MODEL,
    temperature: 0.45,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
You are ${BUSINESS_NAME}'s SMS assistant.

Use this source of truth as your only business knowledge:
${AI_SOURCE_OF_TRUTH}

Write one short, natural customer-facing reply.
Be warm, concise, helpful, and booking-oriented.
Ask only one clear next question when more information is needed.
Use conversation history to resolve vague replies like "yes", "that", or "I want to book it".
If a fact is not in the source of truth or conversation history, do not guess.
Do not invent pricing, availability, policies, instructors, dates, or promises.
Normal pricing questions can be answered only when exact approved pricing exists in the source of truth or conversation history.
Escalate custom pricing, discounts, refunds, disputes, chargebacks, policy exceptions, angry customers, unsafe content, legal issues, unclear high-stakes requests, or any request requiring unavailable calendar access.
Respect opt-outs and cooling-off decisions if they are indicated.
Never mention OpenAI, automation, prompts, internal state, or that you are an AI.
Return only JSON with this exact shape:
{
  "intent": "short_intent_label",
  "confidence": 0.0,
  "risk_level": "low" | "medium" | "high",
  "can_auto_send": true,
  "escalation_required": false,
  "escalation_reason": null,
  "reply_text": "customer-facing SMS text"
}
        `.trim(),
      },
      {
        role: "user",
        content: `
Business: ${BUSINESS_NAME}
Contact name: ${input.contactName?.trim() || "Unknown"}
Channel: ${input.channel || "sms"}
Conversation state: ${input.currentState}
Detected playbook: ${input.playbook}
Conversation history:
${formatConversationHistory(input.conversationHistory)}

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

function isLikelyE164Phone(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value.trim());
}

function normalizeAiDecision(value: unknown): AiResponseDecision {
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
      typeof parsed.escalation_reason === "string" &&
      parsed.escalation_reason.trim()
        ? parsed.escalation_reason.trim()
        : escalationRequired
        ? "AI marked this message for human review."
        : null,
    reply_text: replyText,
  };
}

function buildFallbackDecision(reason: string): AiResponseDecision {
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

function getAutoSendDecision(input: {
  inboundText: string;
  decision: AiResponseDecision;
  channel?: string | null;
  phone?: unknown;
}): { shouldAutoSend: boolean; reason: string } {
  if (!AI_AUTO_SEND_POLICY.enabled) {
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

  if (input.decision.confidence < AI_AUTO_SEND_POLICY.minConfidence) {
    return { shouldAutoSend: false, reason: "low_ai_confidence" };
  }

  if (input.decision.risk_level !== "low") {
    return { shouldAutoSend: false, reason: "non_low_risk_level" };
  }

  if (input.decision.reply_text.length > AI_AUTO_SEND_POLICY.maxSmsLength) {
    return { shouldAutoSend: false, reason: "response_too_long" };
  }

  if (includesAnyTerm(input.inboundText, AI_AUTO_SEND_POLICY.riskyInboundTerms)) {
    return { shouldAutoSend: false, reason: "risky_inbound_topic" };
  }

  if (
    includesAnyTerm(input.decision.reply_text, AI_AUTO_SEND_POLICY.riskyResponseTerms)
  ) {
    return { shouldAutoSend: false, reason: "risky_response_claim" };
  }

  return { shouldAutoSend: true, reason: "low_risk_sms_reply" };
}

function getNextConversationState(
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

export async function POST(req: Request) {
  const denied = await gateInternalOrBusinessUser(req);
  if (denied) return denied;

  const internalCaller = isInternalSecretAuthorizedRequest(req);

  try {
    const body = await req.json();
    const conversationId = body.conversation_id;

    if (!conversationId) {
      return NextResponse.json(
        { success: false, error: "Missing conversation_id" },
        { status: 400 }
      );
    }

    const { data: conversation, error: conversationError } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", conversationId)
      .single();

    if (conversationError || !conversation) {
      return NextResponse.json(
        {
          success: false,
          error: conversationError?.message || "Conversation not found",
        },
        { status: 500 }
      );
    }

    const { data: latestMessage, error: messageError } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (messageError || !latestMessage) {
      return NextResponse.json(
        {
          success: false,
          error: messageError?.message || "No inbound message found",
        },
        { status: 500 }
      );
    }

    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", latestMessage.contact_id)
      .single();

    if (contactError || !contact) {
      return NextResponse.json(
        {
          success: false,
          error: contactError?.message || "Contact not found",
        },
        { status: 500 }
      );
    }

    if (contact.sms_opt_out) {
      return NextResponse.json({
        success: false,
        blocked: true,
        reason: "Contact has opted out of SMS",
      });
    }

    if (
      contact.cooling_off_until &&
      new Date(contact.cooling_off_until) > new Date()
    ) {
      return NextResponse.json({
        success: false,
        blocked: true,
        reason: "Contact is in cooling off period",
      });
    }

    const inboundText = latestMessage.message_text || "";
    const playbook = decidePlaybook(inboundText);
    const currentState = conversation.status || "new_inquiry";
    const { data: recentMessages, error: historyError } = await supabase
      .from("messages")
      .select("direction, channel, message_text, status, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(8);

    if (historyError) {
      return NextResponse.json(
        {
          success: false,
          error: historyError.message || "Conversation history lookup failed",
        },
        { status: 500 }
      );
    }

    const conversationHistory = [
      ...((recentMessages ?? []) as ConversationHistoryMessage[]),
    ].reverse();
    let aiGenerationError: string | null = null;
    const aiDecision = await generateAiDecision({
      inboundText,
      playbook,
      currentState,
      contactName: contact.name,
      channel: latestMessage.channel,
      conversationHistory,
    }).catch((error: unknown) => {
      const message = errorMessage(error, "AI response generation failed");
      aiGenerationError = message;
      return buildFallbackDecision(message);
    });
    const responseText = aiDecision.reply_text;
    const nextState = getNextConversationState(
      currentState,
      playbook,
      inboundText
    );
    const autoSendDecision = getAutoSendDecision({
      inboundText,
      decision: aiDecision,
      channel: latestMessage.channel,
      phone: contact.phone,
    });
    const shouldEscalate = !autoSendDecision.shouldAutoSend;

    const { data: outboundMessage, error: outboundError } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        contact_id: latestMessage.contact_id,
        lead_id: latestMessage.lead_id,
        direction: "outbound",
        channel: latestMessage.channel || "web",
        message_text: responseText,
        status: shouldEscalate ? "needs_human" : PENDING_SEND_STATUS,
        delivery_status: "not_sent",
        ai_generated: true,
        ai_model: AI_RESPONSE_MODEL,
        ai_confidence: aiDecision.confidence,
        intent: aiDecision.intent,
        risk_level: aiDecision.risk_level,
        escalation_required: shouldEscalate,
        escalation_reason: shouldEscalate
          ? aiDecision.escalation_reason || autoSendDecision.reason
          : null,
        metadata: {
          ai_decision: aiDecision,
          auto_send_decision: autoSendDecision,
          ai_generation_error: aiGenerationError,
        },
      })
      .select()
      .single();

    if (outboundError || !outboundMessage) {
      return NextResponse.json(
        {
          success: false,
          error: outboundError?.message || "Outbound message insert failed",
        },
        { status: 500 }
      );
    }

    let sendStatus = PENDING_SEND_STATUS;
    let providerMessageId: string | null = null;
    let sendErrorMessage: string | null = null;

    if (autoSendDecision.shouldAutoSend) {
      try {
        const smsResult = await sendMessage({
          channel: "sms",
          to: contact.phone.trim(),
          message: responseText,
          name: contact.name,
        });
        sendStatus = smsResult.status || "queued";
        providerMessageId = smsResult.external_id;

        const { error: updateError } = await supabase
          .from("messages")
          .update({
            status: sendStatus,
            provider: smsResult.provider,
            external_id: providerMessageId,
            delivery_status: sendStatus,
            sent_at: new Date().toISOString(),
          })
          .eq("id", outboundMessage.id);

        if (updateError) {
          sendErrorMessage = updateError.message;
        }
      } catch (sendError: unknown) {
        sendStatus = "failed";
        sendErrorMessage = errorMessage(sendError, "SMS send failed");

        await supabase
          .from("messages")
          .update({
            status: sendStatus,
            delivery_status: "failed",
            metadata: {
              ai_decision: aiDecision,
              auto_send_decision: autoSendDecision,
              ai_generation_error: aiGenerationError,
              send_error: sendErrorMessage,
            },
          })
          .eq("id", outboundMessage.id);
      }
    }

    await supabase
      .from("conversations")
      .update({
        ...(nextState !== currentState ? { status: nextState } : {}),
        last_message_at: new Date().toISOString(),
        last_outbound_at: new Date().toISOString(),
        needs_human: shouldEscalate,
        human_reason: shouldEscalate
          ? aiDecision.escalation_reason || autoSendDecision.reason
          : null,
      })
      .eq("id", conversationId);

    await supabase.from("audit_logs").insert({
      event_type: "ai_response_generated",
      entity_type: "conversation",
      entity_id: conversationId,
      metadata: {
        playbook,
        state: currentState,
        next_state: nextState,
        inbound_message_id: latestMessage.id,
        outbound_message_id: outboundMessage.id,
        contact_id: contact.id,
        ai_model: AI_RESPONSE_MODEL,
        ai_decision: aiDecision,
        ai_generation_error: aiGenerationError,
        auto_send: {
          attempted: autoSendDecision.shouldAutoSend,
          reason: autoSendDecision.reason,
          status: sendStatus,
          provider: "sentdm",
          provider_message_id: providerMessageId,
          error: sendErrorMessage,
        },
        invoked_via: internalCaller ? "internal_secret" : "dashboard_user",
      },
    });

    return NextResponse.json({
      success: true,
      state: currentState,
      playbook,
      intent: aiDecision.intent,
      confidence: aiDecision.confidence,
      risk_level: aiDecision.risk_level,
      escalation_required: shouldEscalate,
      escalation_reason: shouldEscalate
        ? aiDecision.escalation_reason || autoSendDecision.reason
        : null,
      response_text: responseText,
      outbound_message_id: outboundMessage.id,
      send_status: sendStatus,
      auto_send_reason: autoSendDecision.reason,
      provider_message_id: providerMessageId,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: errorMessage(err, "Unknown error") },
      { status: 500 }
    );
  }
}
