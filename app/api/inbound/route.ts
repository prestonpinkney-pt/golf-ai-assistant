import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { logMessagingAudit } from "@/lib/messaging/audit";
import { isInboundQuietHoursActive } from "@/lib/messaging/quiet-hours";
import { resolveBusinessMessagingConfigFromDb, getHelpResponseForConfig, getOptInAcknowledgementForConfig } from "@/lib/business-messaging-config";
import { postgrestMissingBusinessIdColumn } from "@/lib/supabase-postgrest-errors";
import { getResolvedMessagingProvider } from "@/lib/messaging/provider-resolve";
import { sendMessage } from "@/lib/send-message";


const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type DbRow = Record<string, unknown>;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function getInboundSecret() {
  return process.env.INTERNAL_API_SECRET || "";
}

function isAuthorizedInboundRequest(req: Request) {
  const secret = getInboundSecret();
  if (!secret) return false;

  const sharedSecret =
    req.headers.get("x-inbound-api-secret") ||
    req.headers.get("x-internal-api-secret");
  if (sharedSecret && timingSafeEqualStrings(sharedSecret, secret)) {
    return true;
  }

  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  return timingSafeEqualStrings(authorization, `Bearer ${secret}`);
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
function mapLeadSource(rawSource?: string): string {
  const source = (rawSource || "").toLowerCase();

  if (source === "website" || source === "website_form" || source === "web") {
    return "website_form";
  }

  if (source === "instagram" || source === "ig") {
    return "instagram";
  }

  if (source === "mailchimp") {
    return "mailchimp";
  }

  if (source === "square") {
    return "square";
  }

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

  if (text.includes("junior")) {
    return "junior_program";
  }

  if (text.includes("corporate booking")) {
    return "corporate_booking";
  }

  return "general_question";
}

function isOptOutMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const stopWords = [
    "stop",
    "stop all",
    "unsubscribe",
    "cancel",
    "end",
    "quit",
    "spam",
  ];
  return stopWords.includes(normalized);
}

/** TCPA-style opt-in keywords (carrier resubscribe). */
function isOptInMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "start" ||
    normalized === "unstop" ||
    normalized === "subscribe"
  );
}

function isHumanHelpMessage(text: string): boolean {
  return /\b(help|agent|support|person|human)\b/i.test(text.trim());
}

function isMenuMessage(text: string): boolean {
  return /\b(menu|list|options|settings|preferences)\b/i.test(text.trim());
}

function isLikelyE164Phone(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value.trim());
}

function isUninterestedMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const uninterestedPhrases = [
    "not interested",
    "maybe later",
    "i'm good",
    "im good",
    "i’ll let you know",
    "i'll let you know",
    "not right now",
    "just looking",
  ];
  return uninterestedPhrases.some((phrase) => normalized.includes(phrase));
}

async function saveAndSendAutomatedReply(input: {
  conversation: DbRow;
  contact: DbRow;
  lead: DbRow;
  inboundMessage: DbRow;
  text: string;
  businessName?: string | null;
  escalationRequired?: boolean;
  escalationReason?: string | null;
  intent: string;
}) {
  const contactPhone = typeof input.contact.phone === "string" ? input.contact.phone : "";
  const channel =
    typeof input.inboundMessage.channel === "string" ? input.inboundMessage.channel : "web";
  const shouldSend = channel === "sms" && isLikelyE164Phone(contactPhone);
  const initialStatus = shouldSend ? "pending_send" : "needs_human";

  const { data: outboundMessage, error: outboundError } = await supabase
    .from("messages")
    .insert({
      conversation_id: input.conversation.id,
      contact_id: input.contact.id,
      lead_id: input.lead.id,
      direction: "outbound",
      channel,
      message_text: input.text,
      status: initialStatus,
      delivery_status: "not_sent",
      ai_generated: false,
      intent: input.intent,
      escalation_required: input.escalationRequired === true,
      escalation_reason: input.escalationReason ?? null,
      metadata: {
        automated_control_reply: true,
        inbound_message_id: input.inboundMessage.id,
      },
    })
    .select()
    .single();

  if (outboundError || !outboundMessage) {
    return {
      success: false,
      error: outboundError?.message || "Automated reply insert failed",
      status: 500,
    };
  }

  let sendStatus = initialStatus;
  let providerMessageId: string | null = null;
  let sendError: string | null = null;

  if (shouldSend) {
    try {
      const result = await sendMessage({
        channel: "sms",
        to: contactPhone.trim(),
        message: input.text,
        name: typeof input.contact.name === "string" ? input.contact.name : null,
        businessName: input.businessName,
      });
      sendStatus = result.status || "queued";
      providerMessageId = result.external_id;

      const { error: updateError } = await supabase
        .from("messages")
        .update({
          status: sendStatus,
          provider: result.provider,
          external_id: providerMessageId,
          provider_message_id: providerMessageId,
          delivery_status: sendStatus,
          sent_at: new Date().toISOString(),
        })
        .eq("id", outboundMessage.id);

      if (updateError) sendError = updateError.message;
    } catch (error: unknown) {
      sendStatus = "failed";
      sendError = errorMessage(error, "Automated reply send failed");

      await supabase
        .from("messages")
        .update({
          status: sendStatus,
          delivery_status: "failed",
          metadata: {
            automated_control_reply: true,
            inbound_message_id: input.inboundMessage.id,
            send_error: sendError,
          },
        })
        .eq("id", outboundMessage.id);

      await logMessagingAudit(supabase, {
        event_type: "messaging_provider_send_failed",
        entity_type: "message",
        entity_id: outboundMessage.id as string,
        metadata: {
          intent: input.intent,
          provider: getResolvedMessagingProvider(),
          error: sendError,
          conversation_id: input.conversation.id,
        },
      });
    }
  }

  await supabase
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      last_outbound_at: new Date().toISOString(),
      needs_human: input.escalationRequired === true,
      human_reason: input.escalationReason ?? null,
    })
    .eq("id", input.conversation.id);

  return {
    success: true,
    outbound_message_id: outboundMessage.id,
    send_status: sendStatus,
    provider_message_id: providerMessageId,
    send_error: sendError,
    status: 200,
  };
}

export async function POST(req: Request) {
  if (!isAuthorizedInboundRequest(req)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();

    const phone = body.phone || null;
    const name = body.name || null;
    const source = body.source || "website";
    const messageText = body.message || "";
    const destinationNumber =
      body.to ||
      body.to_number ||
      body.destination ||
      body.destination_phone ||
      body.raw_payload?.to ||
      body.raw_payload?.to_number ||
      null;
    const businessConfig = await resolveBusinessMessagingConfigFromDb(supabase, {
      businessId: body.business_id,
      businessSlug: body.business_slug,
      toNumber: destinationNumber,
    });

    if (!phone) {
      return NextResponse.json(
        { success: false, error: "Missing phone number" },
        { status: 400 }
      );
    }

    const mappedLeadSource = mapLeadSource(source);
    const mappedLeadType = mapLeadType(messageText);

    // 1. Save inbound event
    const { data: inboundEvent, error: inboundError } = await supabase
      .from("inbound_events")
      .insert({
        source,
        raw_payload: {
          ...body,
          business_context: {
            business_id: businessConfig.id,
            business_slug: businessConfig.slug,
            business_name: businessConfig.name,
            assistant_name: businessConfig.assistantName,
            destination_number: destinationNumber,
          },
        },
        status: "received",
        retry_count: 0,
      })
      .select()
      .single();

    if (inboundError || !inboundEvent) {
      return NextResponse.json(
        {
          success: false,
          error: inboundError?.message || "Inbound event insert returned null",
          step: "inbound_event",
        },
        { status: 500 }
      );
    }

    // 2. Find existing contact by phone
    const contactLookupResult = await supabase
      .from("contacts")
      .select("*")
      .eq("phone", phone)
      .maybeSingle();
    let contact = contactLookupResult.data;
    const contactLookupError = contactLookupResult.error;

    if (contactLookupError) {
      await supabase
        .from("inbound_events")
        .update({
          status: "failed",
          error_message: contactLookupError.message,
          error_source: "contact_lookup",
        })
        .eq("id", inboundEvent.id);

      return NextResponse.json(
        {
          success: false,
          error: contactLookupError.message,
          step: "contact_lookup",
        },
        { status: 500 }
      );
    }

    // 3. Create contact if not found
    if (!contact) {
      const { data: newContact, error: contactCreateError } = await supabase
        .from("contacts")
        .insert({
          phone,
          name,
        })
        .select()
        .single();

      if (contactCreateError || !newContact) {
        await supabase
          .from("inbound_events")
          .update({
            status: "failed",
            error_message:
              contactCreateError?.message || "Contact insert returned null",
            error_source: "contact_create",
          })
          .eq("id", inboundEvent.id);

        return NextResponse.json(
          {
            success: false,
            error:
              contactCreateError?.message || "Contact insert returned null",
            step: "contact_create",
          },
          { status: 500 }
        );
      }

      contact = newContact;
    }

    if (!contact) {
      return NextResponse.json(
        {
          success: false,
          error: "Contact is null after lookup/create",
          step: "contact_final",
        },
        { status: 500 }
      );
    }

    // 4. Find existing active conversation first. If one exists, reuse its
    // lead instead of creating a duplicate lead for every SMS reply.
    const conversationBase = () =>
      supabase
        .from("conversations")
        .select("*")
        .eq("contact_id", contact.id)
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

    let conversation = conversationLookupResult.data;
    const conversationLookupError = conversationLookupResult.error;

    if (conversationLookupError) {
      await supabase
        .from("inbound_events")
        .update({
          status: "failed",
          error_message: conversationLookupError.message,
          error_source: "conversation_lookup",
        })
        .eq("id", inboundEvent.id);

      return NextResponse.json(
        {
          success: false,
          error: conversationLookupError.message,
          step: "conversation_lookup",
        },
        { status: 500 }
      );
    }

    let lead: DbRow | null = null;
    let qualificationProfile: DbRow | null = null;

    if (conversation?.lead_id) {
      const { data: existingLead, error: existingLeadError } = await supabase
        .from("leads")
        .select("*")
        .eq("id", conversation.lead_id)
        .maybeSingle();

      if (existingLeadError) {
        await supabase
          .from("inbound_events")
          .update({
            status: "failed",
            error_message: existingLeadError.message,
            error_source: "lead_lookup",
          })
          .eq("id", inboundEvent.id);

        return NextResponse.json(
          {
            success: false,
            error: existingLeadError.message,
            step: "lead_lookup",
          },
          { status: 500 }
        );
      }

      lead = existingLead;

      if (lead?.id) {
        const { data: existingQualificationProfile } = await supabase
          .from("qualification_profiles")
          .select("*")
          .eq("lead_id", lead.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        qualificationProfile = existingQualificationProfile;
      }
    }

    if (!lead) {
      const { data: newLead, error: leadError } = await supabase
        .from("leads")
        .insert({
          contact_id: contact.id,
          full_name: name || "",
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
        await supabase
          .from("inbound_events")
          .update({
            status: "failed",
            error_message: leadError?.message || "Lead insert returned null",
            error_source: "lead_create",
          })
          .eq("id", inboundEvent.id);

        return NextResponse.json(
          {
            success: false,
            error: leadError?.message || "Lead insert returned null",
            step: "lead_create",
          },
          { status: 500 }
        );
      }

      lead = newLead;
    }

    if (!lead) {
      return NextResponse.json(
        {
          success: false,
          error: "Lead is null after lookup/create",
          step: "lead_final",
        },
        { status: 500 }
      );
    }

    if (!qualificationProfile) {
      const template = getQualificationTemplateByLeadType(mappedLeadType);

      const {
        data: newQualificationProfile,
        error: qualificationProfileError,
      } = await supabase
        .from("qualification_profiles")
        .insert({
          lead_id: lead.id,
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

      if (qualificationProfileError || !newQualificationProfile) {
        await supabase
          .from("inbound_events")
          .update({
            status: "failed",
            error_message:
              qualificationProfileError?.message ||
              "Qualification profile insert returned null",
            error_source: "qualification_profile_create",
          })
          .eq("id", inboundEvent.id);

        return NextResponse.json(
          {
            success: false,
            error:
              qualificationProfileError?.message ||
              "Qualification profile insert returned null",
            step: "qualification_profile_create",
          },
          { status: 500 }
        );
      }

      qualificationProfile = newQualificationProfile;
    }

    if (!qualificationProfile) {
      return NextResponse.json(
        {
          success: false,
          error: "Qualification profile is null after lookup/create",
          step: "qualification_profile_final",
        },
        { status: 500 }
      );
    }

    if (!conversation) {
      let conversationCreateResult = await supabase
        .from("conversations")
        .insert({
          contact_id: contact.id,
          lead_id: lead.id,
          status: "new_inquiry",
          business_id: businessConfig.id,
        })
        .select()
        .single();

      if (
        conversationCreateResult.error &&
        postgrestMissingBusinessIdColumn(
          conversationCreateResult.error.message
        )
      ) {
        conversationCreateResult = await supabase
          .from("conversations")
          .insert({
            contact_id: contact.id,
            lead_id: lead.id,
            status: "new_inquiry",
          })
          .select()
          .single();
      }

      const newConversation = conversationCreateResult.data;
      const conversationCreateError = conversationCreateResult.error;

      if (conversationCreateError || !newConversation) {
        await supabase
          .from("inbound_events")
          .update({
            status: "failed",
            error_message:
              conversationCreateError?.message ||
              "Conversation insert returned null",
            error_source: "conversation_create",
          })
          .eq("id", inboundEvent.id);

        return NextResponse.json(
          {
            success: false,
            error:
              conversationCreateError?.message ||
              "Conversation insert returned null",
            step: "conversation_create",
          },
          { status: 500 }
        );
      }

      conversation = newConversation;
    }

    // 7. Save inbound message
    const { data: message, error: messageError } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversation.id,
        contact_id: contact.id,
        lead_id: lead.id,
        direction: "inbound",
        channel: source === "sms" ? "sms" : "web",
        message_text: messageText,
        status: "received",
        provider: body.provider || null,
        external_id: body.external_id || null,
        delivery_status: "received",
        metadata: {
          inbound_event_id: inboundEvent.id,
          business_id: businessConfig.id,
          business_slug: businessConfig.slug,
          business_name: businessConfig.name,
          assistant_name: businessConfig.assistantName,
          destination_number: destinationNumber,
          raw_payload: body.raw_payload ?? body,
        },
      })
      .select()
      .single();

    if (messageError || !message) {
      await supabase
        .from("inbound_events")
        .update({
          status: "failed",
          error_message:
            messageError?.message || "Message insert returned null",
          error_source: "message_create",
        })
        .eq("id", inboundEvent.id);

      return NextResponse.json(
        {
          success: false,
          error: messageError?.message || "Message insert returned null",
          step: "message_create",
        },
        { status: 500 }
      );
    }

    const nowIso = new Date().toISOString();
    await supabase
      .from("conversations")
      .update({
        last_message_at: nowIso,
        last_inbound_at: nowIso,
      })
      .eq("id", conversation.id);

    // 8. START / UNSTOP (resubscribe)
    if (isOptInMessage(messageText)) {
      await supabase
        .from("contacts")
        .update({
          sms_opt_out: false,
          sms_opt_out_at: null,
          sms_opt_out_reason: null,
        })
        .eq("id", contact.id);

      await logMessagingAudit(supabase, {
        event_type: "sms_opt_in_detected",
        entity_type: "contact",
        entity_id: contact.id as string,
        metadata: {
          message: messageText,
          conversation_id: conversation.id,
          inbound_event_id: inboundEvent.id,
          business_id: businessConfig.id,
        },
      });

      const autoReplyResult = await saveAndSendAutomatedReply({
        conversation,
        contact,
        lead,
        inboundMessage: message,
        text: getOptInAcknowledgementForConfig(businessConfig),
        businessName: businessConfig.name,
        intent: "sms_opt_in",
      });

      await supabase
        .from("inbound_events")
        .update({ status: "processed" })
        .eq("id", inboundEvent.id);

      return NextResponse.json(
        {
          success: autoReplyResult.success,
          control_reply: "opt_in",
          contact_id: contact.id,
          lead_id: lead.id,
          conversation_id: conversation.id,
          message_id: message.id,
          automated_reply: autoReplyResult,
        },
        { status: autoReplyResult.status }
      );
    }

    // 9. STOP handling
    if (isOptOutMessage(messageText)) {
      await supabase
        .from("contacts")
        .update({
          sms_opt_out: true,
          sms_opt_out_at: new Date().toISOString(),
          sms_opt_out_reason: messageText,
        })
        .eq("id", contact.id);

      await supabase.from("audit_logs").insert({
        event_type: "sms_opt_out_detected",
        entity_type: "contact",
        entity_id: contact.id,
        metadata: {
          message: messageText,
          conversation_id: conversation.id,
          inbound_event_id: inboundEvent.id,
        },
      });

      const autoReplyResult = await saveAndSendAutomatedReply({
        conversation,
        contact,
        lead,
        inboundMessage: message,
        text: businessConfig.optOutResponse,
        businessName: businessConfig.name,
        intent: "sms_opt_out",
      });

      await supabase
        .from("inbound_events")
        .update({ status: "processed" })
        .eq("id", inboundEvent.id);

      return NextResponse.json(
        {
          success: autoReplyResult.success,
          control_reply: "opt_out",
          contact_id: contact.id,
          lead_id: lead.id,
          conversation_id: conversation.id,
          message_id: message.id,
          automated_reply: autoReplyResult,
        },
        { status: autoReplyResult.status }
      );
    }

    // Contacts who have opted out: store the message but do not send HELP/menu/AI auto-replies.
    if (Boolean(contact.sms_opt_out)) {
      await logMessagingAudit(supabase, {
        event_type: "inbound_suppressed_sms_opt_out",
        entity_type: "contact",
        entity_id: contact.id as string,
        metadata: {
          conversation_id: conversation.id,
          inbound_event_id: inboundEvent.id,
          message_id: message.id,
          business_id: businessConfig.id,
        },
      });

      await supabase
        .from("inbound_events")
        .update({ status: "processed" })
        .eq("id", inboundEvent.id);

      return NextResponse.json({
        success: true,
        blocked: true,
        reason: "sms_opt_out_active",
        contact_id: contact.id,
        lead_id: lead.id,
        conversation_id: conversation.id,
        message_id: message.id,
      });
    }

    if (isHumanHelpMessage(messageText)) {
      const autoReplyResult = await saveAndSendAutomatedReply({
        conversation,
        contact,
        lead,
        inboundMessage: message,
        text: getHelpResponseForConfig(businessConfig),
        businessName: businessConfig.name,
        escalationRequired: true,
        escalationReason: "Customer requested a live agent.",
        intent: "human_help_requested",
      });

      await supabase.from("audit_logs").insert({
        event_type: "human_help_requested",
        entity_type: "conversation",
        entity_id: conversation.id,
        metadata: {
          inbound_event_id: inboundEvent.id,
          message_id: message.id,
          business_id: businessConfig.id,
        },
      });

      await supabase
        .from("inbound_events")
        .update({ status: "processed" })
        .eq("id", inboundEvent.id);

      return NextResponse.json(
        {
          success: autoReplyResult.success,
          control_reply: "human_help",
          contact_id: contact.id,
          lead_id: lead.id,
          conversation_id: conversation.id,
          message_id: message.id,
          automated_reply: autoReplyResult,
        },
        { status: autoReplyResult.status }
      );
    }

    if (isMenuMessage(messageText)) {
      const autoReplyResult = await saveAndSendAutomatedReply({
        conversation,
        contact,
        lead,
        inboundMessage: message,
        text: businessConfig.menuResponse,
        businessName: businessConfig.name,
        intent: "menu_requested",
      });

      await supabase.from("audit_logs").insert({
        event_type: "menu_requested",
        entity_type: "conversation",
        entity_id: conversation.id,
        metadata: {
          inbound_event_id: inboundEvent.id,
          message_id: message.id,
          business_id: businessConfig.id,
        },
      });

      await supabase
        .from("inbound_events")
        .update({ status: "processed" })
        .eq("id", inboundEvent.id);

      return NextResponse.json(
        {
          success: autoReplyResult.success,
          control_reply: "menu",
          contact_id: contact.id,
          lead_id: lead.id,
          conversation_id: conversation.id,
          message_id: message.id,
          automated_reply: autoReplyResult,
        },
        { status: autoReplyResult.status }
      );
    }

    // 9. Cooling-off handling
    if (isUninterestedMessage(messageText)) {
      const coolingOffUntil = new Date();
      coolingOffUntil.setDate(coolingOffUntil.getDate() + 14);

      await supabase
        .from("contacts")
        .update({
          cooling_off_until: coolingOffUntil.toISOString(),
          cooling_off_reason: messageText,
        })
        .eq("id", contact.id);

      await supabase.from("audit_logs").insert({
        event_type: "cooling_off_started",
        entity_type: "contact",
        entity_id: contact.id,
        metadata: {
          message: messageText,
          conversation_id: conversation.id,
          inbound_event_id: inboundEvent.id,
          cooling_off_until: coolingOffUntil.toISOString(),
        },
      });
    }

    // 10. Audit successful inbound processing
    await supabase.from("audit_logs").insert({
      event_type: "inbound_processed",
      entity_type: "conversation",
      entity_id: conversation.id,
      metadata: {
        inbound_event_id: inboundEvent.id,
        contact_id: contact.id,
        lead_id: lead.id,
        qualification_profile_id: qualificationProfile.id,
        message_id: message.id,
        source,
        mapped_lead_source: mappedLeadSource,
        mapped_lead_type: mappedLeadType,
      },
    });

    // 11. Mark inbound event processed
    await supabase
      .from("inbound_events")
      .update({
        status: "processed",
      })
      .eq("id", inboundEvent.id);

    // 12. Trigger AI response (skipped during configured quiet hours for SMS)
    let aiResult: unknown = null;

    if (source === "sms" && isInboundQuietHoursActive()) {
      await logMessagingAudit(supabase, {
        event_type: "quiet_hours_ai_suppressed",
        entity_type: "conversation",
        entity_id: conversation.id as string,
        metadata: {
          inbound_event_id: inboundEvent.id,
          message_id: message.id,
          business_id: businessConfig.id,
        },
      });
      aiResult = {
        success: false,
        suppressed: true,
        reason: "quiet_hours",
      };
    } else {
      try {
        const aiResponse = await fetch(new URL("/api/ai/respond", req.url), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getInboundSecret()}`,
          },
          body: JSON.stringify({
            conversation_id: conversation.id,
          }),
        });

        aiResult = await aiResponse.json();
      } catch (aiError: unknown) {
        aiResult = {
          success: false,
          error: errorMessage(aiError, "AI trigger failed"),
        };
      }
    }

    return NextResponse.json({
      success: true,
      inbound_event_id: inboundEvent.id,
      contact_id: contact.id,
      lead_id: lead.id,
      qualification_profile_id: qualificationProfile.id,
      conversation_id: conversation.id,
      message_id: message.id,
      ai_result: aiResult,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: errorMessage(err, "Unknown error"),
        step: "catch",
      },
      { status: 500 }
    );
  }
}
