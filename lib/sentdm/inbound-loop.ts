import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildSmsBookingFlowMetadataRecord,
  createSmsBookingNoneAugmentation,
} from "@/lib/ai/sms-booking-flow";
import {
  AI_RESPONSE_MODEL,
  applyMisunderstoodRouting,
  buildFallbackDecision,
  decidePlaybook,
  generateAiDecision,
  getAutoSendDecision,
  getNextConversationState,
  type AiResponseDecision,
  type ConversationHistoryMessage,
  type RiskLevel,
} from "@/lib/ai/conversation-reply-core";
import { applySafeBookingQualificationNormalization } from "@/lib/ai/safe-booking-qualification-reply";
import { isLikelyE164Phone } from "@/lib/ai/phone-e164";
import { maybeUpdateConversationSummary } from "@/lib/agent/conversation-summary";
import { businessRulesGate } from "@/lib/agent/business-rules-gate";
import {
  getHelpResponseForConfig,
  messagingAutoSendPolicy,
  resolveBusinessMessagingConfigFromDb,
} from "@/lib/business-messaging-config";
import { detectCarrierComplianceKind } from "@/lib/sentdm/carrier-compliance";
import { computeInboundProviderSendDecision } from "@/lib/sentdm/live-agent-outbound";
import {
  computeCoolingOffUntil,
  isContactInCoolingOff,
  isUninterestedMessage,
} from "@/lib/messaging/cooling-off";
import { extractSentDmInboundPayload } from "@/lib/messaging/sentdm-webhook";
import {
  loadSmsConversationHistoryAscending,
  runInboundSmsBookingAugmentationPhase,
} from "@/lib/sentdm/inbound-sms-booking-phase";
import { finalizeLiveSmsOutboundText } from "@/lib/sentdm/live-sms-outbound-finalize";
import { logMessagingAudit } from "@/lib/messaging/audit";
import { postgrestMissingBusinessIdColumn } from "@/lib/supabase-postgrest-errors";
import { sendSentDmMessage } from "@/lib/sentdm/send-message";

type DbRow = Record<string, unknown>;

export type SentDmInboundLoopResult = {
  ok: boolean;
  statusCode: number;
  body: Record<string, unknown>;
};

const PENDING_SEND = "pending_send";

type InboundLoopAiReply = {
  replyText: string;
  intent: string;
  conversationStage: string;
  shouldSend: boolean;
  shouldEscalate: boolean;
  confidence: number;
  riskLevel: RiskLevel;
  escalationReason: string | null;
  autoSendReason: string;
};

function safeErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function audit(
  supabase: SupabaseClient,
  row: {
    event_type: string;
    entity_type: string;
    entity_id?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const { error } = await supabase.from("audit_logs").insert({
    event_type: row.event_type,
    entity_type: row.entity_type,
    entity_id: row.entity_id ?? null,
    metadata: row.metadata ?? {},
  });
  if (error) {
    console.warn(`[sentdm/inbound-loop] audit_logs: ${error.message}`);
  }
}

function scheduleConversationSummaryRefresh(
  supabase: SupabaseClient,
  conversationId: string
) {
  void (async () => {
    try {
      const result = await maybeUpdateConversationSummary(supabase, conversationId);
      if (!result.ok) {
        await audit(supabase, {
          event_type: "conversation_summary_failed",
          entity_type: "conversation",
          entity_id: conversationId,
          metadata: {
            source: "sentdm_inbound_loop",
            error: result.error,
          },
        });
      }
    } catch (error: unknown) {
      await audit(supabase, {
        event_type: "conversation_summary_failed",
        entity_type: "conversation",
        entity_id: conversationId,
        metadata: {
          source: "sentdm_inbound_loop",
          error: safeErrorMessage(error, "conversation_summary_throw"),
        },
      });
    }
  })();
}

function mapLeadSource(rawSource?: string): string {
  const source = (rawSource || "").toLowerCase();
  if (source === "website" || source === "website_form" || source === "web") {
    return "website_form";
  }
  if (source === "instagram" || source === "ig") return "instagram";
  if (source === "mailchimp") return "mailchimp";
  if (source === "square") return "square";
  if (source === "chat" || source === "chat_widget" || source === "sms") {
    return "chat_widget";
  }
  return "manual";
}

function mapLeadType(message?: string): string {
  const text = (message || "").toLowerCase();
  if (
    text.includes("lesson") ||
    text.includes("swing") ||
    text.includes("1 hour") ||
    text.includes("30 min")
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
  if (text.includes("junior")) return "junior_program";
  if (text.includes("corporate booking")) return "corporate_booking";
  return "general_question";
}

function getLessonQualificationTemplate() {
  return {
    profile_type: "lesson",
    data_json: {
      lesson_length: null,
      lesson_type: null,
      timing_preference: null,
      improvement_focus: null,
    },
    field_confidence_json: {
      lesson_length: 0,
      lesson_type: 0,
      timing_preference: 0,
      improvement_focus: 0,
    },
    field_source_json: {
      lesson_length: null,
      lesson_type: null,
      timing_preference: null,
      improvement_focus: null,
    },
    missing_fields: [
      "lesson_length",
      "lesson_type",
      "timing_preference",
      "improvement_focus",
    ],
    qualification_score: 0,
    readiness_score: 0,
    last_question_asked: null,
    next_question:
      "Happy to help. Are you looking for a 30-minute or 1-hour lesson, and is it for you or someone else?",
    next_best_action: "ask_question",
  };
}

function getEventQualificationTemplate() {
  return {
    profile_type: "event",
    data_json: {
      event_type: null,
      duration_hours: null,
      preferred_date_time: null,
      head_count: null,
      food_beverage_interest: null,
    },
    field_confidence_json: {
      event_type: 0,
      duration_hours: 0,
      preferred_date_time: 0,
      head_count: 0,
      food_beverage_interest: 0,
    },
    field_source_json: {
      event_type: null,
      duration_hours: null,
      preferred_date_time: null,
      head_count: null,
      food_beverage_interest: null,
    },
    missing_fields: [
      "event_type",
      "duration_hours",
      "preferred_date_time",
      "head_count",
      "food_beverage_interest",
    ],
    qualification_score: 0,
    readiness_score: 0,
    last_question_asked: null,
    next_question:
      "Happy to help. What type of event are you planning, and about how many people are you expecting?",
    next_best_action: "ask_question",
  };
}

function getMembershipQualificationTemplate() {
  return {
    profile_type: "membership",
    data_json: {
      play_frequency: null,
      usage_goal: null,
      lesson_interest: null,
      timing_preference: null,
    },
    field_confidence_json: {
      play_frequency: 0,
      usage_goal: 0,
      lesson_interest: 0,
      timing_preference: 0,
    },
    field_source_json: {
      play_frequency: null,
      usage_goal: null,
      lesson_interest: null,
      timing_preference: null,
    },
    missing_fields: [
      "play_frequency",
      "usage_goal",
      "lesson_interest",
      "timing_preference",
    ],
    qualification_score: 0,
    readiness_score: 0,
    last_question_asked: null,
    next_question:
      "Happy to help. Are you mainly looking to practice, play more often, or a mix of both?",
    next_best_action: "ask_question",
  };
}

function getGeneralQualificationTemplate() {
  return {
    profile_type: "general_question",
    data_json: {},
    field_confidence_json: {},
    field_source_json: {},
    missing_fields: [],
    qualification_score: 0,
    readiness_score: 0,
    last_question_asked: null,
    next_question:
      "Happy to help. Are you looking to book time, get a lesson, ask about membership, or plan something for a group?",
    next_best_action: "ask_question",
  };
}

function getQualificationTemplateByLeadType(leadType: string) {
  switch (leadType) {
    case "lesson":
      return getLessonQualificationTemplate();
    case "event":
      return getEventQualificationTemplate();
    case "membership":
      return getMembershipQualificationTemplate();
    default:
      return getGeneralQualificationTemplate();
  }
}

export async function runSentDmInboundConversationLoop(params: {
  supabase: SupabaseClient;
  rawPayload: Record<string, unknown>;
  externalId: string | null;
  ingestSource: "sentdm_webhook" | "sentdm_inbound_route";
}): Promise<SentDmInboundLoopResult> {
  const { supabase, rawPayload, externalId } = params;
  const parsed = extractSentDmInboundPayload(rawPayload);

  let inboundEventId: string | null = null;

  const failInbound = async (message: string, source: string) => {
    if (inboundEventId) {
      await supabase
        .from("inbound_events")
        .update({
          status: "failed",
          error_message: message,
          error_source: source,
        })
        .eq("id", inboundEventId);
    }
  };

  try {
    if (!parsed.phone || !parsed.messageText) {
      return {
        ok: false,
        statusCode: 400,
        body: {
          error: "missing_phone_or_message",
          phone: Boolean(parsed.phone),
          message: Boolean(parsed.messageText),
        },
      };
    }

    const phone = parsed.phone.trim();
    const messageText = parsed.messageText;
    const inboundChannel =
      parsed.channel === "rcs" ? ("rcs" as const) : ("sms" as const);

    const businessConfig = await resolveBusinessMessagingConfigFromDb(supabase, {
      businessId: parsed.businessId,
      businessSlug: parsed.businessSlug,
      toNumber: parsed.toNumber ?? undefined,
    });

    await audit(supabase, {
      event_type: "sentdm_loop_received",
      entity_type: "messaging",
      entity_id: externalId,
      metadata: {
        source: params.ingestSource,
        external_id: externalId,
        business_id: businessConfig.id,
      },
    });

    const { data: inboundEvent, error: inboundErr } = await supabase
      .from("inbound_events")
      .insert({
        source: "sms",
        raw_payload: {
          envelope: rawPayload,
          ingest: params.ingestSource,
          normalized: { phone, message_text: messageText, channel: inboundChannel },
        },
        status: "received",
        retry_count: 0,
      })
      .select()
      .single();

    if (inboundErr || !inboundEvent) {
      return {
        ok: false,
        statusCode: 500,
        body: {
          step: "inbound_event_insert",
          error: inboundErr?.message ?? "Inbound event missing",
        },
      };
    }
    inboundEventId = inboundEvent.id as string;

    await audit(supabase, {
      event_type: "sentdm_loop_inbound_event_created",
      entity_type: "inbound_event",
      entity_id: inboundEvent.id as string,
      metadata: {},
    });

    const mappedLeadSource = mapLeadSource("sms");
    const mappedLeadType = mapLeadType(messageText);

    const contactLookupResult = await supabase
      .from("contacts")
      .select("*")
      .eq("phone", phone)
      .maybeSingle();
    if (contactLookupResult.error) {
      await failInbound(contactLookupResult.error.message, "contact_lookup");
      return {
        ok: false,
        statusCode: 500,
        body: {
          step: "contact_lookup",
          error: contactLookupResult.error.message,
        },
      };
    }

    let contact = contactLookupResult.data;
    if (!contact) {
      const { data: created, error: createErr } = await supabase
        .from("contacts")
        .insert({ phone, name: parsed.name })
        .select()
        .single();

      if (createErr || !created) {
        await failInbound(
          createErr?.message ?? "contact_create_failed",
          "contact_create"
        );
        return {
          ok: false,
          statusCode: 500,
          body: { step: "contact_create", error: createErr?.message },
        };
      }
      contact = created;
    }

    await audit(supabase, {
      event_type: "sentdm_loop_contact_resolved",
      entity_type: "contact",
      entity_id: String(contact!.id),
      metadata: {},
    });

    const conversationBase = () =>
      supabase
        .from("conversations")
        .select("*")
        .eq("contact_id", contact!.id as string)
        .in("status", ["new_inquiry", "qualifying", "ready_to_book"])
        .order("created_at", { ascending: false })
        .limit(1);

    let conversationLookupResult = await conversationBase()
      .eq("business_id", businessConfig.id)
      .maybeSingle();

    if (
      conversationLookupResult.error &&
      postgrestMissingBusinessIdColumn(conversationLookupResult.error.message)
    ) {
      conversationLookupResult = await conversationBase().maybeSingle();
    }

    if (conversationLookupResult.error) {
      await failInbound(
        conversationLookupResult.error.message,
        "conversation_lookup"
      );
      return {
        ok: false,
        statusCode: 500,
        body: {
          step: "conversation_lookup",
          error: conversationLookupResult.error.message,
        },
      };
    }

    let conversation = conversationLookupResult.data as DbRow | null;
    let lead: DbRow | null = null;
    let qualificationProfile: DbRow | null = null;

    if ((conversation?.lead_id as string | undefined)?.length) {
      const { data: existingLead } = await supabase
        .from("leads")
        .select("*")
        .eq("id", conversation!.lead_id as string)
        .maybeSingle();

      lead = existingLead ?? null;

      if (lead?.id) {
        const { data: existingQualProfile } = await supabase
          .from("qualification_profiles")
          .select("*")
          .eq("lead_id", lead.id as string)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        qualificationProfile = existingQualProfile ?? null;
      }
    }

    if (!lead) {
      const { data: newLead, error: leadError } = await supabase
        .from("leads")
        .insert({
          contact_id: contact!.id as string,
          full_name: (parsed.name as string) || "",
          phone,
          message: messageText,
          source: mappedLeadSource,
          lead_type: mappedLeadType,
          status: "new",
          temperature: "cold",
          priority: "medium",
          estimated_value: 0,
          stage: "new_inquiry",
          objection_tags: [],
          engagement_score: 0,
          conversion_probability: 0,
          responsiveness_score: 0,
          value_sensitivity_score: 0,
          urgency_score: 0,
          follow_up_count: 0,
        })
        .select()
        .single();

      if (leadError || !newLead) {
        await failInbound(
          leadError?.message ?? "lead_create_failed",
          "lead_create"
        );
        return {
          ok: false,
          statusCode: 500,
          body: { step: "lead_create", error: leadError?.message },
        };
      }
      lead = newLead;
    }

    if (!lead) {
      await failInbound("lead_null_after_create", "lead_final");
      return { ok: false, statusCode: 500, body: { step: "lead_final" } };
    }

    if (!qualificationProfile) {
      const template = getQualificationTemplateByLeadType(mappedLeadType);
      const { data: qp, error: qpErr } = await supabase
        .from("qualification_profiles")
        .insert({
          lead_id: lead.id as string,
          profile_type: template.profile_type,
          data_json: template.data_json,
          field_confidence_json: template.field_confidence_json,
          field_source_json: template.field_source_json,
          missing_fields: template.missing_fields,
          qualification_score: template.qualification_score,
          readiness_score: template.readiness_score,
          last_question_asked: template.last_question_asked,
          next_question: template.next_question,
          next_best_action: template.next_best_action,
        })
        .select()
        .single();

      if (qpErr || !qp) {
        await failInbound(
          qpErr?.message ?? "qualification_profile_missing",
          "qualification_profile_create"
        );
        return {
          ok: false,
          statusCode: 500,
          body: { step: "qualification_profile_create", error: qpErr?.message },
        };
      }
      qualificationProfile = qp;
    }

    if (!conversation) {
      let createResult = await supabase
        .from("conversations")
        .insert({
          contact_id: contact!.id as string,
          lead_id: lead!.id as string,
          status: "new_inquiry",
          stage: "new_inquiry",
          automation_enabled: true,
          human_takeover: false,
          business_id: businessConfig.id,
        })
        .select()
        .single();

      if (
        createResult.error &&
        postgrestMissingBusinessIdColumn(createResult.error.message)
      ) {
        createResult = await supabase
          .from("conversations")
          .insert({
            contact_id: contact!.id as string,
            lead_id: lead!.id as string,
            status: "new_inquiry",
            stage: "new_inquiry",
            automation_enabled: true,
            human_takeover: false,
          })
          .select()
          .single();
      }

      if (createResult.error || !createResult.data) {
        await failInbound(
          createResult.error?.message ?? "conversation_create_missing",
          "conversation_create"
        );
        return {
          ok: false,
          statusCode: 500,
          body: {
            step: "conversation_create",
            error: createResult.error?.message,
          },
        };
      }
      conversation = createResult.data as DbRow;
    }

    await audit(supabase, {
      event_type: "sentdm_loop_conversation_resolved",
      entity_type: "conversation",
      entity_id: String(conversation!.id),
      metadata: {},
    });

    if (externalId) {
      const { data: dupeMsg } = await supabase
        .from("messages")
        .select("id")
        .eq("conversation_id", conversation!.id as string)
        .eq("external_id", externalId)
        .maybeSingle();
      if (dupeMsg) {
        await supabase
          .from("inbound_events")
          .update({ status: "processed", error_message: null })
          .eq("id", inboundEventId);
        await audit(supabase, {
          event_type: "sentdm_loop_inbound_duplicate",
          entity_type: "message",
          entity_id: String(dupeMsg.id),
          metadata: { external_id: externalId },
        });
        return {
          ok: true,
          statusCode: 200,
          body: { duplicate: true, dedup_external_id: externalId },
        };
      }
    }

    const { data: inboundMessage, error: msgErr } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversation!.id as string,
        contact_id: contact!.id as string,
        lead_id: lead!.id as string,
        contact_phone: phone,
        direction: "inbound",
        channel: inboundChannel,
        message_text: messageText,
        body: messageText,
        sender_type: "customer",
        status: "received",
        provider: "sentdm",
        external_id: externalId,
        provider_message_id: externalId,
        delivery_status: "received",
        metadata: {
          inbound_event_id: inboundEventId,
          business_id: businessConfig.id,
          business_slug: businessConfig.slug,
        },
      })
      .select()
      .single();

    if (msgErr || !inboundMessage) {
      await failInbound(
        msgErr?.message ?? "inbound_message_insert_failed",
        "message_create"
      );
      return {
        ok: false,
        statusCode: 500,
        body: { step: "inbound_message", error: msgErr?.message },
      };
    }

    const nowIso = new Date().toISOString();

    await supabase
      .from("conversations")
      .update({
        last_message_at: nowIso,
        last_inbound_at: nowIso,
        last_customer_message_at: nowIso,
      })
      .eq("id", conversation!.id as string);

    await audit(supabase, {
      event_type: "sentdm_loop_inbound_message_saved",
      entity_type: "message",
      entity_id: String(inboundMessage.id),
      metadata: { intent_hint: mappedLeadType },
    });

    if (detectCarrierComplianceKind(messageText) === "stop") {
      await supabase
        .from("contacts")
        .update({
          sms_opt_out: true,
          sms_opt_out_at: nowIso,
          sms_opt_out_reason: messageText,
        })
        .eq("id", contact!.id as string);

      await audit(supabase, {
        event_type: "sentdm_loop_stop_handled",
        entity_type: "contact",
        entity_id: String(contact!.id),
        metadata: { conversation_id: conversation!.id },
      });

      const stopText =
        businessConfig.optOutResponse?.trim()?.length ?
          businessConfig.optOutResponse.trim()
        : "You're unsubscribed. Reply HELP for Primetime Golf or START to resubscribe.";

      const stopBase = stopText.slice(0, businessConfig.maxSmsLength);
      let stopPersist = stopBase;
      if (inboundChannel === "sms") {
        const f = finalizeLiveSmsOutboundText({
          draftReply: stopBase,
          channel: inboundChannel,
          businessName: businessConfig.name,
          assistantName: businessConfig.assistantName,
          shouldDiscloseAutomation: false,
          bookingConfirmedByWhoosh: false,
        });
        stopPersist = f.responseText.slice(0, businessConfig.maxSmsLength);
        if (f.confirmationGuardBlocked) {
          await logMessagingAudit(supabase, {
            event_type: "sms_booking_confirmation_blocked",
            entity_type: "conversation",
            entity_id: String(conversation!.id),
            metadata: {
              source: "sentdm_inbound_loop",
              pathway: "compliance_stop_reply",
            },
          });
        }
      }

      const { data: outMsg, error: stopInsertErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversation!.id as string,
          contact_id: contact!.id as string,
          lead_id: lead!.id as string,
          contact_phone: phone,
          direction: "outbound",
          channel: inboundChannel,
          message_text: stopPersist,
          body: stopPersist,
          sender_type: "ai",
          status: PENDING_SEND,
          delivery_status: "not_sent",
          ai_generated: false,
          intent: "stop",
          metadata: {
            compliance_stop_confirm: true,
            inbound_message_id: inboundMessage.id,
            business_id: businessConfig.id,
          },
        })
        .select()
        .single();

      if (stopInsertErr || !outMsg) {
        await failInbound(
          stopInsertErr?.message ?? "stop_outbound_missing",
          "stop_out_insert"
        );
        return {
          ok: false,
          statusCode: 500,
          body: { step: "stop_outbound", error: stopInsertErr?.message },
        };
      }

      let sendOk = false;
      if (
        outMsg &&
        isLikelyE164Phone(phone) &&
        businessConfig.autoSendEnabled &&
        stopPersist.trim().length
      ) {
        try {
          const sendRes = await sendSentDmMessage({
            to: phone.trim(),
            message: stopPersist,
            channel: inboundChannel === "rcs" ? "rcs" : "sms",
            name:
              typeof contact?.name === "string" ?
                contact.name
              : null,
            businessName: businessConfig.name,
            idempotencyKey: String(outMsg.id),
          });
          sendOk = true;
          const sentAt = new Date().toISOString();
          await supabase
            .from("messages")
            .update({
              status: sendRes.status ?? "queued",
              delivery_status: sendRes.status ?? "queued",
              provider: sendRes.provider,
              external_id: sendRes.external_id,
              provider_message_id: sendRes.external_id,
              sent_at: sentAt,
            })
            .eq("id", outMsg?.id);
          await supabase
            .from("conversations")
            .update({
              last_outbound_at: sentAt,
              last_ai_message_at: sentAt,
            })
            .eq("id", conversation!.id as string);
        } catch (e: unknown) {
          console.error("[sentdm/inbound-loop] stop send:", e);
          await audit(supabase, {
            event_type: "sentdm_loop_stop_send_failed",
            entity_type: "message",
            entity_id: outMsg?.id as string | undefined,
            metadata: { error: safeErrorMessage(e, "send_failed") },
          });
        }
      }

      await supabase.from("audit_logs").insert({
        event_type: "sms_opt_out_detected",
        entity_type: "contact",
        entity_id: contact!.id as string,
        metadata: {
          conversation_id: conversation!.id,
          inbound_event_id: inboundEventId,
        },
      });

      await supabase
        .from("inbound_events")
        .update({ status: "processed" })
        .eq("id", inboundEventId);

      return {
        ok: true,
        statusCode: 200,
        body: {
          control_reply: "opt_out",
          conversation_id: conversation!.id,
          compliance_sent: sendOk,
        },
      };
    }

    if (detectCarrierComplianceKind(messageText) === "help") {
      const helpRaw = getHelpResponseForConfig(businessConfig).trim();
      const helpText =
        helpRaw.length ?
          helpRaw.slice(0, businessConfig.maxSmsLength)
        : "Reply STOP to unsubscribe anytime.".slice(
            0,
            businessConfig.maxSmsLength
          );

      await audit(supabase, {
        event_type: "sentdm_loop_help_handled",
        entity_type: "contact",
        entity_id: String(contact!.id),
        metadata: { conversation_id: conversation!.id },
      });

      let helpPersist = helpText;
      if (inboundChannel === "sms") {
        const f = finalizeLiveSmsOutboundText({
          draftReply: helpText,
          channel: inboundChannel,
          businessName: businessConfig.name,
          assistantName: businessConfig.assistantName,
          shouldDiscloseAutomation: false,
          bookingConfirmedByWhoosh: false,
        });
        helpPersist = f.responseText.slice(0, businessConfig.maxSmsLength);
        if (f.confirmationGuardBlocked) {
          await logMessagingAudit(supabase, {
            event_type: "sms_booking_confirmation_blocked",
            entity_type: "conversation",
            entity_id: String(conversation!.id),
            metadata: {
              source: "sentdm_inbound_loop",
              pathway: "compliance_help_reply",
            },
          });
        }
      }

      const { data: helpOutMsg, error: helpInsertErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversation!.id as string,
          contact_id: contact!.id as string,
          lead_id: lead!.id as string,
          contact_phone: phone,
          direction: "outbound",
          channel: inboundChannel,
          message_text: helpPersist,
          body: helpPersist,
          sender_type: "ai",
          status: PENDING_SEND,
          delivery_status: "not_sent",
          ai_generated: false,
          intent: "support",
          metadata: {
            compliance_help_reply: true,
            inbound_message_id: inboundMessage.id,
            business_id: businessConfig.id,
          },
        })
        .select()
        .single();

      if (helpInsertErr || !helpOutMsg) {
        await failInbound(
          helpInsertErr?.message ?? "help_outbound_missing",
          "help_out_insert"
        );
        return {
          ok: false,
          statusCode: 500,
          body: { step: "help_outbound", error: helpInsertErr?.message },
        };
      }

      let helpSendOk = false;
      if (
        helpOutMsg &&
        isLikelyE164Phone(phone) &&
        businessConfig.autoSendEnabled &&
        helpPersist.trim().length
      ) {
        try {
          const sendRes = await sendSentDmMessage({
            to: phone.trim(),
            message: helpPersist,
            channel: inboundChannel === "rcs" ? "rcs" : "sms",
            name:
              typeof contact?.name === "string" ? contact.name : null,
            businessName: businessConfig.name,
            idempotencyKey: String(helpOutMsg.id),
          });
          helpSendOk = true;
          const sentAt = new Date().toISOString();
          await supabase
            .from("messages")
            .update({
              status: sendRes.status ?? "queued",
              delivery_status: sendRes.status ?? "queued",
              provider: sendRes.provider,
              external_id: sendRes.external_id,
              provider_message_id: sendRes.external_id,
              sent_at: sentAt,
            })
            .eq("id", helpOutMsg.id);
          await supabase
            .from("conversations")
            .update({
              last_outbound_at: sentAt,
              last_ai_message_at: sentAt,
            })
            .eq("id", conversation!.id as string);
        } catch (e: unknown) {
          console.error("[sentdm/inbound-loop] help send:", e);
          await audit(supabase, {
            event_type: "sentdm_loop_help_send_failed",
            entity_type: "message",
            entity_id: String(helpOutMsg.id),
            metadata: { error: safeErrorMessage(e, "send_failed") },
          });
        }
      }

      await supabase
        .from("inbound_events")
        .update({ status: "processed" })
        .eq("id", inboundEventId);

      return {
        ok: true,
        statusCode: 200,
        body: {
          control_reply: "help",
          conversation_id: conversation!.id,
          compliance_sent: helpSendOk,
        },
      };
    }

    if (Boolean(contact!.sms_opt_out)) {
      await audit(supabase, {
        event_type: "sentdm_loop_suppressed_opted_out_contact",
        entity_type: "contact",
        entity_id: contact!.id as string,
        metadata: { conversation_id: conversation!.id },
      });
      await supabase
        .from("inbound_events")
        .update({ status: "processed" })
        .eq("id", inboundEventId);
      return {
        ok: true,
        statusCode: 200,
        body: { suppressed: true, reason: "sms_opt_out_active" },
      };
    }

    if (isUninterestedMessage(messageText)) {
      const coolingOffUntil = computeCoolingOffUntil(new Date());
      const coolingOffIso = coolingOffUntil.toISOString();

      await supabase
        .from("contacts")
        .update({
          cooling_off_until: coolingOffIso,
          cooling_off_reason: messageText,
        })
        .eq("id", contact!.id as string);

      contact = {
        ...(contact as DbRow),
        cooling_off_until: coolingOffIso,
        cooling_off_reason: messageText,
      };

      await audit(supabase, {
        event_type: "cooling_off_started",
        entity_type: "contact",
        entity_id: String(contact!.id),
        metadata: {
          message: messageText,
          conversation_id: conversation!.id,
          inbound_event_id: inboundEventId,
          cooling_off_until: coolingOffIso,
          source: "sentdm_inbound_loop",
        },
      });

      await audit(supabase, {
        event_type: "sentdm_loop_suppressed_cooling_off",
        entity_type: "contact",
        entity_id: String(contact!.id),
        metadata: {
          conversation_id: conversation!.id,
          reason: "uninterested_language",
          cooling_off_until: coolingOffIso,
        },
      });

      await supabase
        .from("inbound_events")
        .update({ status: "processed" })
        .eq("id", inboundEventId);

      scheduleConversationSummaryRefresh(supabase, conversation!.id as string);

      return {
        ok: true,
        statusCode: 200,
        body: {
          suppressed: true,
          reason: "cooling_off_started",
          cooling_off_until: coolingOffIso,
          conversation_id: conversation!.id,
        },
      };
    }

    if (isContactInCoolingOff(contact as DbRow)) {
      await audit(supabase, {
        event_type: "sentdm_loop_suppressed_cooling_off_active",
        entity_type: "contact",
        entity_id: String(contact!.id),
        metadata: {
          conversation_id: conversation!.id,
          cooling_off_until: (contact as DbRow).cooling_off_until ?? null,
        },
      });
      await supabase
        .from("inbound_events")
        .update({ status: "processed" })
        .eq("id", inboundEventId);
      return {
        ok: true,
        statusCode: 200,
        body: { suppressed: true, reason: "cooling_off_active" },
      };
    }

    const gate = businessRulesGate({
      inboundText: messageText,
      contact: contact as DbRow,
      conversation: conversation! as DbRow,
      config: businessConfig,
      now: new Date(),
      optOutPreviously: false,
    });

    const deferOutboundSms = gate.blockImmediateOutbound === true;

    if (!gate.shouldContinueToAI) {
      await audit(supabase, {
        event_type: "sentdm_business_rules_blocked_ai",
        entity_type: "conversation",
        entity_id: String(conversation!.id),
        metadata: {
          reason: gate.reason,
          should_escalate: gate.shouldEscalate,
          should_send: gate.shouldSend,
          block_immediate_outbound: deferOutboundSms,
        },
      });

      if (gate.shouldEscalate) {
        const esc =
          gate.escalationReason?.trim()?.length ?
            gate.escalationReason.trim()
          : gate.reason;
        await supabase
          .from("conversations")
          .update({
            human_takeover: true,
            needs_human: true,
            automation_enabled: false,
            escalation_reason: esc,
            human_reason: esc,
          })
          .eq("id", conversation!.id as string);
      }

      const gateReply = gate.replyText?.trim();
      let gateOutboundId: string | null = null;

      if (gateReply?.length && gate.shouldSend) {
        const outboundStatusGate = gate.shouldEscalate ? "needs_human" : PENDING_SEND;
        const intentLabel =
          gate.reason === "high_risk_escalation" ? "support" : "unknown";

        let gatePersistBody = gateReply.slice(0, businessConfig.maxSmsLength);
        if (inboundChannel === "sms") {
          const gated = finalizeLiveSmsOutboundText({
            draftReply: gatePersistBody,
            channel: inboundChannel,
            businessName: businessConfig.name,
            assistantName: businessConfig.assistantName,
            shouldDiscloseAutomation: false,
            bookingConfirmedByWhoosh: false,
          });
          gatePersistBody = gated.responseText.slice(0, businessConfig.maxSmsLength);
          if (gated.confirmationGuardBlocked) {
            await logMessagingAudit(supabase, {
              event_type: "sms_booking_confirmation_blocked",
              entity_type: "conversation",
              entity_id: String(conversation!.id),
              metadata: {
                source: "sentdm_inbound_loop",
                pathway: "business_rules_gate",
                gate_reason: gate.reason,
              },
            });
          }
        }

        const { data: gateOut, error: goErr } = await supabase
          .from("messages")
          .insert({
            conversation_id: conversation!.id as string,
            contact_id: contact!.id as string,
            lead_id: lead!.id as string,
            contact_phone: phone,
            direction: "outbound",
            channel: inboundChannel,
            message_text: gatePersistBody,
            body: gatePersistBody,
            sender_type: "ai",
            status: outboundStatusGate,
            delivery_status: "not_sent",
            ai_generated: false,
            intent: intentLabel,
            escalation_required: gate.shouldEscalate,
            escalation_reason:
              gate.shouldEscalate ?
                (gate.escalationReason ?? gate.reason)
              : null,
            metadata: {
              business_rules_gate: true,
              gate_reason: gate.reason,
              inbound_message_id: inboundMessage.id,
              business_id: businessConfig.id,
            },
          })
          .select()
          .single();

        if (!goErr && gateOut?.id) {
          gateOutboundId = gateOut.id as string;

          await audit(supabase, {
            event_type: "sentdm_loop_gate_outbound_saved",
            entity_type: "message",
            entity_id: String(gateOut.id),
            metadata: { gate_reason: gate.reason },
          });

          const canSendGate =
            businessConfig.autoSendEnabled &&
            isLikelyE164Phone(phone) &&
            !deferOutboundSms;

          if (canSendGate) {
            try {
              const sendRes = await sendSentDmMessage({
                to: phone.trim(),
                message: gatePersistBody,
                channel: inboundChannel === "rcs" ? "rcs" : "sms",
                name:
                  typeof contact?.name === "string" ?
                    contact.name
                  : null,
                businessName: businessConfig.name,
                idempotencyKey: String(gateOut.id),
              });
              const sentAt = new Date().toISOString();
              await supabase
                .from("messages")
                .update({
                  status: sendRes.status ?? "queued",
                  delivery_status: sendRes.status ?? "queued",
                  provider: sendRes.provider,
                  external_id: sendRes.external_id,
                  provider_message_id: sendRes.external_id,
                  sent_at: sentAt,
                })
                .eq("id", gateOut.id);

              await supabase
                .from("conversations")
                .update({
                  last_outbound_at: sentAt,
                  last_ai_message_at: sentAt,
                })
                .eq("id", conversation!.id as string);
            } catch (e: unknown) {
              console.error("[sentdm/inbound-loop] gate send:", e);
              await audit(supabase, {
                event_type: "sentdm_loop_gate_send_failed",
                entity_type: "message",
                entity_id: String(gateOut.id),
                metadata: { error: safeErrorMessage(e, "gate_send_failed") },
              });
            }
          }
        }
      }

      await supabase
        .from("inbound_events")
        .update({ status: "processed" })
        .eq("id", inboundEventId);

      scheduleConversationSummaryRefresh(supabase, conversation!.id as string);

      return {
        ok: true,
        statusCode: 200,
        body: {
          gate_blocked_ai: true,
          gate_reason: gate.reason,
          gate_outbound_message_id: gateOutboundId,
          conversation_id: conversation!.id,
        },
      };
    }

    const ingestLabel =
      params.ingestSource === "sentdm_webhook" ? "sentdm_webhook"
      : "sentdm_inbound_route";

    let smsBookingFlow = createSmsBookingNoneAugmentation(
      inboundChannel === "sms" ? "sentdm_sms_precheck" : "sentdm_rcs_channel"
    );
    let conversationHistoryAscending: ConversationHistoryMessage[] = [];

    if (inboundChannel === "sms") {
      const phase = await runInboundSmsBookingAugmentationPhase({
        supabase,
        conversationId: conversation!.id as string,
        businessId: businessConfig.id ?? null,
        contactId: (contact!.id as string | undefined) ?? null,
        contactName: typeof contact!.name === "string" ? contact!.name : null,
        contactPhone: phone,
        inboundText: messageText,
        ingestSource: ingestLabel,
      });
      smsBookingFlow = phase.smsBookingFlow;
      conversationHistoryAscending = phase.conversationHistory;
    }

    const smsBookingMetadata = buildSmsBookingFlowMetadataRecord(smsBookingFlow);
    const bookingConfirmedFlag =
      inboundChannel === "sms" &&
      smsBookingFlow.kind === "direct_outbound" &&
      !!smsBookingFlow.bookingConfirmedByWhoosh;

    const shouldDiscloseAutomation =
      inboundChannel === "sms" &&
      !conversationHistoryAscending.some((m) => m.direction === "outbound");

    const skipOpenAi =
      inboundChannel === "sms" && smsBookingFlow.kind === "direct_outbound";

    if (!skipOpenAi) {
      await audit(supabase, {
        event_type: "sentdm_loop_ai_generation_started",
        entity_type: "conversation",
        entity_id: String(conversation!.id),
        metadata: {
          sms_booking_flow_kind: smsBookingFlow.kind,
        },
      });
    }

    const { data: convAiRow } = await supabase
      .from("conversations")
      .select("summary")
      .eq("id", conversation!.id as string)
      .maybeSingle();

    const conversationSummaryForAi =
      typeof convAiRow?.summary === "string" && convAiRow.summary.trim().length > 0
        ? convAiRow.summary.trim()
        : typeof conversation.summary === "string"
          ? conversation.summary.trim()
          : null;

    const playbook = decidePlaybook(messageText);
    const currentState =
      typeof conversation!.status === "string" && conversation!.status.trim()
        ? conversation!.status.trim()
        : "new_inquiry";

    if (inboundChannel !== "sms" && conversationHistoryAscending.length === 0) {
      conversationHistoryAscending = await loadSmsConversationHistoryAscending(
        supabase,
        conversation!.id as string
      );
    }

    const runtimeAppendixParts: string[] = [];
    if (conversationSummaryForAi) {
      runtimeAppendixParts.push(
        "Long-running conversation summary (soft background only; inbound_text and recent messages win on conflict):\n" +
          conversationSummaryForAi
      );
    }
    if (inboundChannel === "sms" && smsBookingFlow.kind === "appendix") {
      runtimeAppendixParts.push(smsBookingFlow.text);
    }
    const runtimeAppendix =
      runtimeAppendixParts.length > 0 ? runtimeAppendixParts.join("\n\n") : null;

    let reply: InboundLoopAiReply;
    let aiGenerationError: string | null = null;

    if (skipOpenAi) {
      if (smsBookingFlow.kind !== "direct_outbound") {
        throw new Error("[sentdm/inbound-loop] expected direct_outbound booking flow");
      }
      const directDecision: AiResponseDecision = {
        intent: "booking_flow_direct",
        confidence: 0.93,
        risk_level: "low",
        can_auto_send: true,
        escalation_required: false,
        escalation_reason: null,
        reply_text: smsBookingFlow.replyText,
      };
      const autoSendDecision = getAutoSendDecision({
        inboundText: messageText,
        decision: directDecision,
        channel: inboundChannel,
        phone,
        bypassRiskyResponseTerms: !!smsBookingFlow.bypassRiskyResponseGuard,
        policy: messagingAutoSendPolicy(businessConfig),
      });
      reply = {
        replyText: smsBookingFlow.replyText,
        intent: "booking",
        conversationStage: "sms_booking_flow_direct",
        shouldSend: autoSendDecision.shouldAutoSend,
        shouldEscalate: !autoSendDecision.shouldAutoSend,
        confidence: 0.93,
        riskLevel: "low",
        escalationReason: autoSendDecision.shouldAutoSend
          ? null
          : directDecision.escalation_reason ?? autoSendDecision.reason,
        autoSendReason: autoSendDecision.reason,
      };
    } else if (!process.env.OPENAI_API_KEY?.trim()) {
      reply = {
        replyText:
          "Thanks for texting Primetime Golf. A staff member will follow up shortly.",
        intent: "unknown",
        conversationStage: "escalated_no_model",
        shouldSend: false,
        shouldEscalate: true,
        confidence: 0.2,
        riskLevel: "high",
        escalationReason: "OPENAI_API_KEY is not configured.",
        autoSendReason: "auto_send_disabled",
      };
    } else {
      const aiDecisionRaw = await generateAiDecision({
        inboundText: messageText,
        playbook,
        currentState,
        contactName: typeof contact!.name === "string" ? contact!.name : null,
        channel: inboundChannel,
        businessName: businessConfig.name,
        assistantName: businessConfig.assistantName,
        shouldDiscloseAutomation,
        sourceOfTruth: businessConfig.aiSourceOfTruth,
        conversationHistory: conversationHistoryAscending,
        runtimeAppendix,
      }).catch(async (error: unknown) => {
        aiGenerationError = safeErrorMessage(error, "generate_ai_decision_throw");
        await audit(supabase, {
          event_type: "sentdm_loop_ai_generation_failed",
          entity_type: "conversation",
          entity_id: String(conversation!.id),
          metadata: {
            error: aiGenerationError,
          },
        });
        return buildFallbackDecision(aiGenerationError);
      });

      const aiDecision = applySafeBookingQualificationNormalization(
        applyMisunderstoodRouting(
          aiDecisionRaw,
          businessConfig.name,
          Math.min(businessConfig.minConfidence, 0.42)
        ),
        {
          inboundText: messageText,
          playbook,
          intent: aiDecisionRaw.intent,
        }
      );

      const nextState = getNextConversationState(currentState, playbook, messageText);
      const autoSendDecision = getAutoSendDecision({
        inboundText: messageText,
        decision: aiDecision,
        channel: inboundChannel,
        phone,
        policy: messagingAutoSendPolicy(businessConfig),
      });
      const shouldEscalate = !autoSendDecision.shouldAutoSend;

      reply = {
        replyText: aiDecision.reply_text,
        intent: aiDecision.intent,
        conversationStage: nextState,
        shouldSend: autoSendDecision.shouldAutoSend,
        shouldEscalate,
        confidence: aiDecision.confidence,
        riskLevel: aiDecision.risk_level,
        escalationReason: shouldEscalate
          ? aiDecision.escalation_reason ?? autoSendDecision.reason
          : null,
        autoSendReason: autoSendDecision.reason,
      };
    }

    const cappedDraft = reply.replyText.slice(0, businessConfig.maxSmsLength);
    const outboundFinalization = finalizeLiveSmsOutboundText({
      draftReply: cappedDraft,
      channel: inboundChannel,
      businessName: businessConfig.name,
      assistantName: businessConfig.assistantName,
      shouldDiscloseAutomation,
      bookingConfirmedByWhoosh: bookingConfirmedFlag,
    });

    if (outboundFinalization.confirmationGuardBlocked && inboundChannel === "sms") {
      await logMessagingAudit(supabase, {
        event_type: "sms_booking_confirmation_blocked",
        entity_type: "conversation",
        entity_id: String(conversation!.id),
        metadata: {
          source: "sentdm_inbound_loop",
          business_id: businessConfig.id,
          playbook: decidePlaybook(messageText),
          booking_confirmed_by_whoosh: bookingConfirmedFlag,
          pattern: outboundFinalization.confirmationGuardMatched ?? null,
          sms_booking_flow_kind: smsBookingFlow.kind,
        },
      });
    }

    const responseText = outboundFinalization.responseText.slice(
      0,
      businessConfig.maxSmsLength
    );

    const escalationHuman = reply.shouldEscalate;
    const convUpdate: DbRow = {
      intent: reply.intent,
      status: reply.conversationStage,
      stage: reply.conversationStage,
      last_message_at: new Date().toISOString(),
    };
    if (escalationHuman) {
      const humanText =
        reply.escalationReason?.trim() ??
        (reply.confidence < businessConfig.minConfidence
          ? `Low AI confidence (${reply.confidence.toFixed(2)}). Escalating.`
          : `Intent ${reply.intent} requires human handling.`);
      convUpdate.needs_human = true;
      convUpdate.human_reason = humanText;
      convUpdate.escalation_reason = humanText;
      convUpdate.human_takeover = true;
      convUpdate.automation_enabled = false;
    }

    await supabase
      .from("conversations")
      .update(convUpdate as Record<string, unknown>)
      .eq("id", conversation!.id as string);

    const outboundStatus =
      escalationHuman ? "needs_human"
      : reply.shouldSend ? PENDING_SEND
      : "needs_human";

    const { data: outboundMessage, error: outErr } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversation!.id as string,
        contact_id: contact!.id as string,
        lead_id: lead!.id as string,
        contact_phone: phone,
        direction: "outbound",
        channel: inboundChannel,
        message_text: responseText,
        body: responseText,
        sender_type: "ai",
        status: outboundStatus,
        delivery_status: "not_sent",
        ai_generated: true,
        ai_model: AI_RESPONSE_MODEL,
        ai_confidence: reply.confidence,
        intent: reply.intent,
        risk_level: reply.riskLevel,
        escalation_required: escalationHuman,
        escalation_reason:
          escalationHuman ? (convUpdate.escalation_reason as string) : null,
        metadata: {
          inbound_message_id: inboundMessage.id,
          business_id: businessConfig.id,
          sentdm_loop: true,
          should_send_model: reply.shouldSend,
          confidence: reply.confidence,
          conversation_stage: reply.conversationStage,
          auto_send_reason: reply.autoSendReason,
          ai_generation_error: aiGenerationError,
          sms_booking_flow: smsBookingMetadata,
          booking_confirmed_by_whoosh: bookingConfirmedFlag,
          confirmation_guard: {
            blocked: outboundFinalization.confirmationGuardBlocked,
            triggered_pattern:
              outboundFinalization.confirmationGuardMatched ?? null,
          },
        },
      })
      .select()
      .single();

    if (outErr || !outboundMessage) {
      await failInbound(outErr?.message ?? "outbound_insert_failed", "outbound_insert");
      return {
        ok: false,
        statusCode: 500,
        body: { step: "outbound_message", error: outErr?.message },
      };
    }

    await audit(supabase, {
      event_type: "sentdm_loop_outbound_message_saved",
      entity_type: "message",
      entity_id: String(outboundMessage.id),
      metadata: { intent: reply.intent },
    });

    const sendDecision = await computeInboundProviderSendDecision(supabase, {
      phone,
      contact: contact! as DbRow,
      conversation: conversation! as DbRow,
      autoSendEnabled: businessConfig.autoSendEnabled,
      modelShouldSend: reply.shouldSend,
      deferOutboundSms,
      escalationHuman,
      riskLevel: reply.riskLevel,
      shouldEscalate: reply.shouldEscalate,
    });

    const allowProviderSend = sendDecision.allowProviderSend;

    if (!allowProviderSend && sendDecision.blocker) {
      await audit(supabase, {
        event_type: "sentdm_outbound_send_blocked_policy",
        entity_type: "message",
        entity_id: String(outboundMessage.id),
        metadata: {
          provider_send_blocker: sendDecision.blocker,
          blocker_detail: sendDecision.blockerDetail,
          policy_reason_codes: sendDecision.policyReasonCodes,
          allowlist_passed: sendDecision.allowlistPassed,
          quiet_hours_active: sendDecision.quietHoursActive,
          live_agent_test_mode: sendDecision.liveAgentTestMode,
          intent: reply.intent,
        },
      });
    }

    if (allowProviderSend) {
      try {
        await audit(supabase, {
          event_type: "sentdm_outbound_send_attempted",
          entity_type: "message",
          entity_id: String(outboundMessage.id),
          metadata: {},
        });
        const sendRes = await sendSentDmMessage({
          to: phone.trim(),
          message: responseText,
          channel: inboundChannel === "rcs" ? "rcs" : "sms",
          name:
            typeof contact?.name === "string" ? contact.name : null,
          businessName: businessConfig.name,
          idempotencyKey: String(outboundMessage.id),
        });
        const sentAt = new Date().toISOString();
        await supabase
          .from("messages")
          .update({
            status: sendRes.status ?? "queued",
            delivery_status: sendRes.status ?? "queued",
            provider: sendRes.provider,
            external_id: sendRes.external_id,
            provider_message_id: sendRes.external_id,
            sent_at: sentAt,
          })
          .eq("id", outboundMessage.id);

        await supabase.from("conversations").update({
          last_outbound_at: sentAt,
          last_ai_message_at: sentAt,
        }).eq("id", conversation!.id as string);

        await audit(supabase, {
          event_type: "sentdm_outbound_send_succeeded",
          entity_type: "message",
          entity_id: String(outboundMessage.id),
          metadata: { provider_message_id: sendRes.external_id },
        });
      } catch (e: unknown) {
        const msg = safeErrorMessage(e, "sentdm_send_failed");
        console.error("[sentdm/inbound-loop]", msg);
        await supabase.from("messages").update({
          status: "failed",
          delivery_status: "failed",
        }).eq("id", outboundMessage.id);
        await audit(supabase, {
          event_type: "sentdm_outbound_send_failed",
          entity_type: "message",
          entity_id: String(outboundMessage.id),
          metadata: {
            error: msg,
            provider_send_blocker: "sentdm_api_error",
          },
        });
      }
    } else {
      await supabase
        .from("messages")
        .update({
          metadata: {
            ...(typeof outboundMessage.metadata === "object" &&
            outboundMessage.metadata &&
            !Array.isArray(outboundMessage.metadata) ?
              (outboundMessage.metadata as Record<string, unknown>)
            : {}),
            provider_send_blocker: sendDecision.blocker,
            provider_send_blocker_detail: sendDecision.blockerDetail,
            allowlist_passed: sendDecision.allowlistPassed,
            quiet_hours_active: sendDecision.quietHoursActive,
            live_agent_test_mode: sendDecision.liveAgentTestMode,
          },
        })
        .eq("id", outboundMessage.id);

      await audit(supabase, {
        event_type: "sentdm_outbound_send_skipped",
        entity_type: "message",
        entity_id: String(outboundMessage.id),
        metadata: {
          auto_enabled: businessConfig.autoSendEnabled,
          model_should_send: reply.shouldSend,
          escalation: escalationHuman,
          defer_outbound_sms: deferOutboundSms,
          quiet_hours_active: sendDecision.quietHoursActive,
          provider_send_blocker: sendDecision.blocker,
          provider_send_blocker_detail: sendDecision.blockerDetail,
          allowlist_passed: sendDecision.allowlistPassed,
          live_agent_test_mode: sendDecision.liveAgentTestMode,
          policy_reason_codes: sendDecision.policyReasonCodes,
        },
      });
    }

    await supabase
      .from("inbound_events")
      .update({ status: "processed" })
      .eq("id", inboundEventId);

    await audit(supabase, {
      event_type: "sentdm_loop_completed",
      entity_type: "conversation",
      entity_id: String(conversation!.id),
      metadata: {
        outbound_message_id: outboundMessage.id,
        intent: reply.intent,
        conversation_stage: reply.conversationStage,
      },
    });

    scheduleConversationSummaryRefresh(supabase, conversation!.id as string);

    return {
      ok: true,
      statusCode: 200,
      body: {
        contact_id: contact!.id,
        conversation_id: conversation!.id,
        inbound_message_id: inboundMessage.id,
        inbound_event_id: inboundEventId,
        outbound_message_id: outboundMessage.id,
        intent: reply.intent,
        conversation_stage: reply.conversationStage,
      },
    };
  } catch (err: unknown) {
    const message = safeErrorMessage(err, "sentdm_loop_unhandled");
    await failInbound(message, "unhandled_exception");
    return {
      ok: false,
      statusCode: 500,
      body: { error: message },
    };
  }
}
