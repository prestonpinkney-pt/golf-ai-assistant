import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

function buildResponseByState(
  state: string,
  playbook: string,
  inboundText: string
): string {
  if (state === "cooling_off") {
    return "Understood. I’ll leave it there for now.";
  }

  if (state === "booked") {
    return "You’re all set. Is there anything else I can help with?";
  }

  if (state === "ready_to_book") {
    switch (playbook) {
      case "lesson":
        return "Perfect. I can help get that set up. Are you looking for a 30-minute or 1-hour lesson?";
      case "event":
        return "Sounds good. I can help get that lined up. What date are you aiming for, and about how many people are you expecting?";
      case "membership":
        return "Got it. I can point you in the right direction. Are you mainly looking to practice, play, or both?";
      default:
        return "Happy to help. What are you looking to get set up?";
    }
  }

  if (state === "qualifying") {
    switch (playbook) {
      case "lesson":
        return "Got it. Is the lesson for you or someone else, and are you looking for a 30-minute or 1-hour session?";
      case "event":
        return "Got it. What type of event are you planning, and about how many people are you expecting?";
      case "membership":
        return "Got it. How often do you see yourself coming in during a normal week?";
      default:
        return "Happy to help. Are you looking to book time, get a lesson, ask about membership, or plan something for a group?";
    }
  }

  // default = new_inquiry
  switch (playbook) {
    case "lesson":
      return "Happy to help. Are you looking for a 30-minute or 1-hour lesson, and is it for you or someone else?";
    case "event":
      return "Happy to help. What type of event are you planning, and about how many people are you expecting?";
    case "membership":
      return "Happy to help. Are you mainly looking to practice, play more often, or a mix of both?";
    default:
      return "Happy to help. Are you looking to book time, get a lesson, ask about membership, or plan something for a group?";
  }
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
    // simple readiness checks for MVP
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
  try {
    const body = await req.json();
    const conversationId = body.conversation_id;

    if (!conversationId) {
      return NextResponse.json(
        { success: false, error: "Missing conversation_id" },
        { status: 400 }
      );
    }

    // 1. Load conversation
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

    // 2. Get latest inbound message
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

    // 3. Get contact
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

    // 4. Block if opted out
    if (contact.sms_opt_out) {
      return NextResponse.json({
        success: false,
        blocked: true,
        reason: "Contact has opted out of SMS",
      });
    }

    // 5. Block if cooling off
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

    // 6. Decide response
    const inboundText = latestMessage.message_text || "";
    const playbook = decidePlaybook(inboundText);
    const currentState = conversation.status || "new_inquiry";
    const responseText = buildResponseByState(
      currentState,
      playbook,
      inboundText
    );
 const nextState = getNextConversationState(
      currentState,
      playbook,
      inboundText
    );
    // 7. Save outbound message
    const { data: outboundMessage, error: outboundError } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        contact_id: latestMessage.contact_id,
        lead_id: latestMessage.lead_id,
        direction: "outbound",
        channel: latestMessage.channel || "web",
        message_text: responseText,
        status: "sent",
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
if (nextState !== currentState) {
      await supabase
        .from("conversations")
        .update({
          status: nextState,
        })
        .eq("id", conversationId);
    }
    // 8. Audit log
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
        sent_to: contact.phone,
      },
    });

    return NextResponse.json({
      success: true,
      state: currentState,
      playbook,
      response_text: responseText,
      outbound_message_id: outboundMessage.id,
      send_status: "sent",
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || "Unknown error" },
      { status: 500 }
    );
  }
}