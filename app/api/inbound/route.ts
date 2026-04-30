import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";


const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
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
  const stopWords = ["stop", "stop all", "unsubscribe", "cancel", "end", "quit"];
  return stopWords.includes(normalized);
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

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const phone = body.phone || null;
    const name = body.name || null;
    const source = body.source || "website";
    const messageText = body.message || "";

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
        raw_payload: body,
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
    let { data: contact, error: contactLookupError } = await supabase
      .from("contacts")
      .select("*")
      .eq("phone", phone)
      .maybeSingle();

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

    // 4. Create lead
    const { data: lead, error: leadError } = await supabase
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

    if (leadError || !lead) {
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

    // 5. Create qualification profile
    const template = getQualificationTemplateByLeadType(mappedLeadType);

    const { data: qualificationProfile, error: qualificationProfileError } =
      await supabase
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

    if (qualificationProfileError || !qualificationProfile) {
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

    // 6. Find existing active conversation first
    let { data: conversation, error: conversationLookupError } = await supabase
      .from("conversations")
      .select("*")
      .eq("contact_id", contact.id)
      .in("status", ["new_inquiry", "qualifying", "ready_to_book"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

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

    if (!conversation) {
      const { data: newConversation, error: conversationCreateError } =
        await supabase
          .from("conversations")
          .insert({
            contact_id: contact.id,
            lead_id: lead.id,
            status: "new_inquiry",
          })
          .select()
          .single();

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

    // 8. STOP handling
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

    // 12. Trigger AI response
    let aiResult: any = null;

    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

      const aiResponse = await fetch(`${appUrl}/api/ai/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversation_id: conversation.id,
        }),
      });

      aiResult = await aiResponse.json();
    } catch (aiError: any) {
      aiResult = {
        success: false,
        error: aiError?.message || "AI trigger failed",
      };
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
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err?.message || "Unknown error",
        step: "catch",
      },
      { status: 500 }
    );
  }
}