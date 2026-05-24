import { NextResponse } from "next/server";
import {
  AI_RESPONSE_MODEL,
  applyMisunderstoodRouting,
  buildFallbackDecision,
  decidePlaybook,
  errorMessage,
  generateAiDecision,
  getAutoSendDecision,
  getMetadataString,
  type ConversationHistoryMessage,
  withAutomationDisclosure,
} from "@/lib/ai/conversation-reply-core";
import { ApiAuthError, requireBusinessUser } from "@/app/api/lib/require-auth";
import {
  messagingAutoSendPolicy,
  resolveBusinessMessagingConfigFromDb,
} from "@/lib/business-messaging-config";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let userId: string;
  try {
    const ctx = await requireBusinessUser();
    userId = ctx.user.id;
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    return NextResponse.json(
      { error: "AI draft generation is not configured (OPENAI_API_KEY)." },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const conversationId =
    typeof (body as { conversation_id?: unknown })?.conversation_id === "string"
      ? (body as { conversation_id: string }).conversation_id.trim()
      : "";

  if (!conversationId || !UUID_RE.test(conversationId)) {
    return NextResponse.json({ error: "Invalid or missing conversation_id" }, { status: 400 });
  }

  const supabase = createSupabaseServiceRoleClient();

  try {
    const { data: conversation, error: conversationError } = await supabase
      .from("conversations")
      .select("id, status")
      .eq("id", conversationId)
      .maybeSingle();

    if (conversationError) throw new Error(conversationError.message);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const { data: latestMessage, error: messageError } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (messageError) throw new Error(messageError.message);
    if (!latestMessage) {
      return NextResponse.json(
        { error: "No inbound message found to draft a reply against." },
        { status: 400 }
      );
    }

    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", latestMessage.contact_id)
      .maybeSingle();

    if (contactError) throw new Error(contactError.message);
    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    if (contact.sms_opt_out) {
      return NextResponse.json(
        { error: "Contact has opted out of SMS; AI drafts are disabled." },
        { status: 403 }
      );
    }

    if (
      contact.cooling_off_until &&
      new Date(contact.cooling_off_until as string) > new Date()
    ) {
      return NextResponse.json(
        { error: "Contact is in a cooling-off period; AI drafts are disabled." },
        { status: 403 }
      );
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
      throw new Error(historyError.message || "Conversation history lookup failed");
    }

    const conversationHistory = [
      ...((recentMessages ?? []) as ConversationHistoryMessage[]),
    ].reverse();

    const businessConfig = await resolveBusinessMessagingConfigFromDb(supabase, {
      businessId: getMetadataString(latestMessage.metadata, "business_id"),
      businessSlug: getMetadataString(latestMessage.metadata, "business_slug"),
      toNumber: getMetadataString(latestMessage.metadata, "destination_number"),
    });

    const shouldDiscloseAutomation =
      latestMessage.channel === "sms" &&
      !conversationHistory.some((message) => message.direction === "outbound");

    let aiGenerationError: string | null = null;
    const aiDecisionRaw = await generateAiDecision({
      inboundText,
      playbook,
      currentState,
      contactName: contact.name,
      channel: latestMessage.channel,
      businessName: businessConfig.name,
      assistantName: businessConfig.assistantName,
      shouldDiscloseAutomation,
      sourceOfTruth: businessConfig.aiSourceOfTruth,
      conversationHistory,
    }).catch((error: unknown) => {
      const message = errorMessage(error, "AI response generation failed");
      aiGenerationError = message;
      return buildFallbackDecision(message);
    });

    const aiDecision = applyMisunderstoodRouting(
      aiDecisionRaw,
      businessConfig.name,
      Math.min(businessConfig.minConfidence, 0.42)
    );

    const responseText = withAutomationDisclosure({
      replyText: aiDecision.reply_text,
      businessName: businessConfig.name,
      assistantName: businessConfig.assistantName,
      shouldDiscloseAutomation,
    });

    const sendDecision = { ...aiDecision, reply_text: responseText };

    const autoSendDecision = getAutoSendDecision({
      inboundText,
      decision: sendDecision,
      channel: latestMessage.channel,
      phone: contact.phone,
      policy: messagingAutoSendPolicy(businessConfig),
    });

    const conversationNeedsReply = Boolean(aiDecision.escalation_required);

    await supabase.from("audit_logs").insert({
      event_type: "ai_operator_draft_generated",
      entity_type: "conversation",
      entity_id: conversationId,
      metadata: {
        business_id: businessConfig.id,
        user_id: userId,
        inbound_message_id: latestMessage.id,
        ai_model: AI_RESPONSE_MODEL,
        conversation_needs_reply: conversationNeedsReply,
        auto_send_would_fire: autoSendDecision.shouldAutoSend,
        auto_send_reason: autoSendDecision.reason,
        ai_generation_error: aiGenerationError,
      },
    });

    return NextResponse.json({
      ok: true,
      draft_text: responseText,
      intent: aiDecision.intent,
      confidence: aiDecision.confidence,
      risk_level: aiDecision.risk_level,
      escalation_required: aiDecision.escalation_required,
      escalation_reason: aiDecision.escalation_reason,
      conversation_needs_reply: conversationNeedsReply,
      /** Informational only — this endpoint never sends. */
      automation_would_auto_send: autoSendDecision.shouldAutoSend,
      automation_auto_send_reason: autoSendDecision.reason,
      ai_generation_error: aiGenerationError,
    });
  } catch (err: unknown) {
    console.error("reply-draft error:", err);
    return NextResponse.json(
      {
        error: errorMessage(err, "Failed to generate draft"),
      },
      { status: 500 }
    );
  }
}
