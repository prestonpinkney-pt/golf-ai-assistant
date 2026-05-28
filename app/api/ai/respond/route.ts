import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import {
  AI_RESPONSE_MODEL,
  PENDING_SEND_STATUS,
  applyMisunderstoodRouting,
  buildFallbackDecision,
  decidePlaybook,
  errorMessage,
  generateAiDecision,
  getAutoSendDecision,
  getMetadataString,
  getNextConversationState,
  type AiResponseDecision,
  type ConversationHistoryMessage,
  withAutomationDisclosure,
} from "@/lib/ai/conversation-reply-core";
import { applySafeBookingQualificationNormalization } from "@/lib/ai/safe-booking-qualification-reply";
import {
  applyBookingConfirmationOutboundGuard,
} from "@/lib/ai/booking-outbound-guard";
import {
  buildSmsBookingFlowMetadataRecord,
  createSmsBookingNoneAugmentation,
  runCloseOsSmsBookingAugmentation,
} from "@/lib/ai/sms-booking-flow";
import { logMessagingAudit } from "@/lib/messaging/audit";
import {
  messagingAutoSendPolicy,
  resolveBusinessMessagingConfigFromDb,
} from "@/lib/business-messaging-config";
import { sendMessage } from "@/lib/send-message";
import { getResolvedMessagingProvider } from "@/lib/messaging/provider-resolve";
import {
  gateInternalOrBusinessUser,
  isInternalSecretAuthorizedRequest,
} from "../../lib/require-auth";

function getSupabase() {
  return createSupabaseServiceRoleClient();
}

/** Best-effort Whoosh member ids from contacts row (`select("*")`). */
function readContactWhooshMemberNumber(contact: unknown): string | null {
  if (!contact || typeof contact !== "object" || Array.isArray(contact)) return null;
  const c = contact as Record<string, unknown>;
  for (const key of ["whoosh_member_number", "member_number", "whooshMemberNumber"] as const) {
    const v = c[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
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

    const { data: conversation, error: conversationError } = await getSupabase()
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

    const { data: latestMessage, error: messageError } = await getSupabase()
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

    const { data: contact, error: contactError } = await getSupabase()
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
    const { data: recentMessages, error: historyError } = await getSupabase()
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
    const businessConfig = await resolveBusinessMessagingConfigFromDb(getSupabase(), {
      businessId: getMetadataString(latestMessage.metadata, "business_id"),
      businessSlug: getMetadataString(latestMessage.metadata, "business_slug"),
      toNumber: getMetadataString(latestMessage.metadata, "destination_number"),
    });
    const shouldDiscloseAutomation =
      latestMessage.channel === "sms" &&
      !conversationHistory.some((message) => message.direction === "outbound");

    let smsBookingFlow =
      latestMessage.channel === "sms"
        ? createSmsBookingNoneAugmentation("pending_sms_augment_initial")
        : createSmsBookingNoneAugmentation("not_sms_channel");

    try {
      if (latestMessage.channel === "sms" && businessConfig.id) {
        smsBookingFlow = await runCloseOsSmsBookingAugmentation({
          supabase: getSupabase(),
          businessId: businessConfig.id,
          conversationId,
          contactId: contact.id,
          contactName: typeof contact.name === "string" ? contact.name : null,
          contactPhone: typeof contact.phone === "string" ? contact.phone : null,
          contactMemberNumber: readContactWhooshMemberNumber(contact),
          inboundText,
          playbook,
          conversationHistory,
        });
      }
    } catch (bookingAugmentError: unknown) {
      console.warn(
        "[ai/respond] sms booking augmentation error:",
        errorMessage(bookingAugmentError, "unknown error")
      );
      smsBookingFlow = createSmsBookingNoneAugmentation("sms_booking_augment_threw_error");
    }

    const bookingConfirmedFlag =
      smsBookingFlow.kind === "direct_outbound" && !!smsBookingFlow.bookingConfirmedByWhoosh;

    const smsBookingMetadata = buildSmsBookingFlowMetadataRecord(smsBookingFlow);

    let aiGenerationError: string | null = null;

    const aiDecisionRaw: AiResponseDecision =
      smsBookingFlow.kind === "direct_outbound"
        ? {
            intent: "booking_flow_direct",
            confidence: 0.93,
            risk_level: "low",
            can_auto_send: true,
            escalation_required: false,
            escalation_reason: null,
            reply_text: smsBookingFlow.replyText,
          }
        : await generateAiDecision({
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
            runtimeAppendix:
              smsBookingFlow.kind === "appendix" ? smsBookingFlow.text : undefined,
          }).catch((error: unknown) => {
            const message = errorMessage(error, "AI response generation failed");
            aiGenerationError = message;
            return buildFallbackDecision(message);
          });

    const aiDecision =
      smsBookingFlow.kind === "direct_outbound"
        ? aiDecisionRaw
        : applySafeBookingQualificationNormalization(
            applyMisunderstoodRouting(
              aiDecisionRaw,
              businessConfig.name,
              Math.min(businessConfig.minConfidence, 0.42)
            ),
            {
              inboundText,
              playbook,
              intent: aiDecisionRaw.intent,
              bookingConfirmedByWhoosh: bookingConfirmedFlag,
            }
          );

    const draftedReply =
      smsBookingFlow.kind === "direct_outbound" ?
        smsBookingFlow.replyText
      : aiDecision.reply_text;

    const disclosedReply = withAutomationDisclosure({
      replyText: draftedReply,
      businessName: businessConfig.name,
      assistantName: businessConfig.assistantName,
      shouldDiscloseAutomation,
    });

    let confirmationGuardBlocked = false;
    let confirmationGuardMatched: string | undefined;

    let responseText = disclosedReply;
    if (latestMessage.channel === "sms") {
      const guarded = applyBookingConfirmationOutboundGuard({
        replyTextFull: disclosedReply,
        bookingConfirmedByWhoosh: bookingConfirmedFlag,
      });
      responseText = guarded.replyTextFull;
      confirmationGuardBlocked = guarded.blocked;
      confirmationGuardMatched = guarded.matchedPattern;

      if (guarded.blocked) {
        await logMessagingAudit(getSupabase(), {
          entity_type: "conversation",
          entity_id: conversationId,
          event_type: "sms_booking_confirmation_blocked",
          metadata: {
            business_id: businessConfig.id,
            booking_confirmed_by_whoosh: bookingConfirmedFlag,
            pattern: guarded.matchedPattern ?? null,
            playbook,
          },
        });
      }
    }

    const sendDecision = { ...aiDecision, reply_text: responseText };
    const nextState = getNextConversationState(
      currentState,
      playbook,
      inboundText
    );
    const autoSendDecision = getAutoSendDecision({
      inboundText,
      decision: sendDecision,
      channel: latestMessage.channel,
      phone: contact.phone,
      bypassRiskyResponseTerms:
        smsBookingFlow.kind === "direct_outbound" &&
        !!smsBookingFlow.bypassRiskyResponseGuard,
      policy: messagingAutoSendPolicy(businessConfig),
    });
    const shouldEscalate = !autoSendDecision.shouldAutoSend;

    const { data: outboundMessage, error: outboundError } = await getSupabase()
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
          ai_decision: sendDecision,
          auto_send_decision: autoSendDecision,
          ai_generation_error: aiGenerationError,
          business_id: businessConfig.id,
          business_slug: businessConfig.slug,
          business_name: businessConfig.name,
          assistant_name: businessConfig.assistantName,
          automation_disclosed: shouldDiscloseAutomation,
          sms_booking_flow: smsBookingMetadata,
          booking_confirmed_by_whoosh: bookingConfirmedFlag,
          confirmation_guard: {
            blocked: confirmationGuardBlocked,
            triggered_pattern: confirmationGuardMatched ?? null,
          },
          auto_send_policy: {
            enabled: businessConfig.autoSendEnabled,
            min_confidence: businessConfig.minConfidence,
            max_sms_length: businessConfig.maxSmsLength,
          },
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
    let outboundSmsProvider: string = getResolvedMessagingProvider();

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
        outboundSmsProvider = smsResult.provider;

        const { error: updateError } = await getSupabase()
          .from("messages")
          .update({
            status: sendStatus,
            provider: smsResult.provider,
            external_id: providerMessageId,
            provider_message_id: providerMessageId,
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

        await getSupabase()
          .from("messages")
          .update({
            status: sendStatus,
            delivery_status: "failed",
            metadata: {
              ai_decision: sendDecision,
              auto_send_decision: autoSendDecision,
              ai_generation_error: aiGenerationError,
              send_error: sendErrorMessage,
              business_id: businessConfig.id,
              business_slug: businessConfig.slug,
              business_name: businessConfig.name,
              assistant_name: businessConfig.assistantName,
              automation_disclosed: shouldDiscloseAutomation,
              sms_booking_flow: smsBookingMetadata,
          booking_confirmed_by_whoosh: bookingConfirmedFlag,
          confirmation_guard: {
            blocked: confirmationGuardBlocked,
            triggered_pattern: confirmationGuardMatched ?? null,
          },
            },
          })
          .eq("id", outboundMessage.id);
      }
    }

    await getSupabase()
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

    await getSupabase().from("audit_logs").insert({
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
        ai_decision: sendDecision,
        ai_generation_error: aiGenerationError,
        business_id: businessConfig.id,
        business_slug: businessConfig.slug,
        auto_send: {
          attempted: autoSendDecision.shouldAutoSend,
          reason: autoSendDecision.reason,
          status: sendStatus,
          provider: outboundSmsProvider,
          provider_message_id: providerMessageId,
          error: sendErrorMessage,
        },
        invoked_via: internalCaller ? "internal_secret" : "dashboard_user",
        sms_booking_flow: smsBookingMetadata,
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
