import { NextResponse } from "next/server";
import { ApiAuthError, requireBusinessUser } from "@/app/api/lib/require-auth";
import { conversationAccessibleToBusiness } from "@/lib/conversations/conversation-tenant";
import { postgrestMissingBusinessIdColumn } from "@/lib/supabase-postgrest-errors";
import { logMessagingAudit } from "@/lib/messaging/audit";
import { normalizePhone } from "@/lib/messaging/phone";
import { sendMessage } from "@/lib/send-message";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_MESSAGE_LENGTH = 1600;

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...NO_STORE_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function isLikelyE164Phone(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value.trim());
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  let userId: string;
  let businessId: string;
  try {
    const ctx = await requireBusinessUser();
    userId = ctx.user.id;
    businessId = ctx.businessId;
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return jsonNoStore({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const { conversationId } = await context.params;
  if (!conversationId || !UUID_RE.test(conversationId)) {
    return jsonNoStore({ error: "Invalid conversation id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as { message?: unknown };
  const messageText =
    typeof payload.message === "string" ? payload.message.trim() : "";

  if (!messageText) {
    return jsonNoStore({ error: "message is required" }, { status: 400 });
  }

  if (messageText.length > MAX_MESSAGE_LENGTH) {
    return jsonNoStore(
      { error: `message must be <= ${MAX_MESSAGE_LENGTH} characters` },
      { status: 400 }
    );
  }

  const supabase = createSupabaseServiceRoleClient();

  try {
    let conversation: {
      id: unknown;
      contact_id: unknown;
      lead_id: unknown;
      business_id?: unknown;
    } | null;
    let convError: { message: string } | null;

    const convWide = await supabase
      .from("conversations")
      .select("id, contact_id, lead_id, business_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (
      convWide.error &&
      postgrestMissingBusinessIdColumn(convWide.error.message)
    ) {
      const convNarrow = await supabase
        .from("conversations")
        .select("id, contact_id, lead_id")
        .eq("id", conversationId)
        .maybeSingle();
      conversation = convNarrow.data;
      convError = convNarrow.error;
    } else {
      conversation = convWide.data;
      convError = convWide.error;
    }

    if (convError) throw new Error(convError.message);
    if (!conversation) {
      return jsonNoStore({ error: "Conversation not found" }, { status: 404 });
    }

    if (
      !conversationAccessibleToBusiness(
        conversation as { business_id?: string | null },
        businessId
      )
    ) {
      return jsonNoStore({ error: "Conversation not found" }, { status: 404 });
    }

    const contactId = conversation.contact_id as string | null;
    if (!contactId) {
      return jsonNoStore(
        { error: "Conversation has no contact" },
        { status: 422 }
      );
    }

    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select(
        "id, name, phone, sms_opt_out, cooling_off_until"
      )
      .eq("id", contactId)
      .maybeSingle();

    if (contactError) throw new Error(contactError.message);
    if (!contact) {
      return jsonNoStore({ error: "Contact not found" }, { status: 404 });
    }

    if (contact.sms_opt_out) {
      await logMessagingAudit(supabase, {
        event_type: "operator_reply_blocked_opt_out",
        entity_type: "conversation",
        entity_id: conversationId,
        metadata: {
          business_id: businessId,
          contact_id: contact.id,
          user_id: userId,
        },
      });
      return jsonNoStore(
        { error: "Contact has opted out of SMS; sending is blocked." },
        { status: 403 }
      );
    }

    if (
      contact.cooling_off_until &&
      new Date(contact.cooling_off_until as string) > new Date()
    ) {
      return jsonNoStore(
        {
          error:
            "Contact is in a cooling-off period; sending is temporarily blocked.",
        },
        { status: 403 }
      );
    }

    const rawPhone =
      typeof contact.phone === "string" ? contact.phone.trim() : "";
    const toPhone = normalizePhone(rawPhone || null);
    if (!toPhone || !isLikelyE164Phone(toPhone)) {
      return jsonNoStore(
        {
          error:
            "Contact phone is missing or not a valid E.164 number; update the contact before sending.",
        },
        { status: 422 }
      );
    }

    const leadId = (conversation.lead_id as string | null) ?? null;

    const { data: outboundMessage, error: insertError } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        contact_id: contactId,
        lead_id: leadId,
        direction: "outbound",
        channel: "sms",
        contact_phone: toPhone,
        message_text: messageText,
        body: messageText,
        status: "pending_send",
        delivery_status: "not_sent",
        ai_generated: false,
        metadata: {
          operator_reply: true,
          operator_user_id: userId,
          business_id: businessId,
        },
      })
      .select()
      .single();

    if (insertError || !outboundMessage) {
      throw new Error(insertError?.message || "Failed to create message row");
    }

    const messageRowId = outboundMessage.id as string;

    try {
      const result = await sendMessage({
        channel: "sms",
        to: toPhone,
        message: messageText,
        name: typeof contact.name === "string" ? contact.name : null,
      });

      const sendStatus = result.status || "queued";
      const sentAt = new Date().toISOString();

      const { data: updated, error: updateError } = await supabase
        .from("messages")
        .update({
          status: sendStatus,
          provider: result.provider,
          external_id: result.external_id,
          provider_message_id: result.external_id,
          delivery_status: sendStatus,
          sent_at: sentAt,
        })
        .eq("id", messageRowId)
        .select()
        .single();

      if (updateError) {
        console.error("operator reply message update failed:", updateError.message);
      }

      const { error: convUpdateError } = await supabase
        .from("conversations")
        .update({
          last_message_at: sentAt,
          last_outbound_at: sentAt,
        })
        .eq("id", conversationId);

      if (convUpdateError) {
        console.error("conversation timestamp update failed:", convUpdateError.message);
      }

      await logMessagingAudit(supabase, {
        event_type: "operator_outbound_reply_sent",
        entity_type: "message",
        entity_id: messageRowId,
        metadata: {
          business_id: businessId,
          conversation_id: conversationId,
          contact_id: contactId,
          user_id: userId,
          provider: result.provider,
          external_id: result.external_id,
          status: sendStatus,
        },
      });

      return jsonNoStore({
        ok: true,
        message: updated ?? { ...outboundMessage, status: sendStatus, sent_at: sentAt },
      });
    } catch (sendErr: unknown) {
      const sendErrorMessage = errorMessage(sendErr, "Provider send failed");
      const baseMeta =
        outboundMessage.metadata &&
        typeof outboundMessage.metadata === "object" &&
        !Array.isArray(outboundMessage.metadata)
          ? (outboundMessage.metadata as Record<string, unknown>)
          : {};

      await supabase
        .from("messages")
        .update({
          status: "failed",
          delivery_status: "failed",
          metadata: {
            ...baseMeta,
            send_error: sendErrorMessage,
          },
        })
        .eq("id", messageRowId);

      await logMessagingAudit(supabase, {
        event_type: "operator_outbound_reply_failed",
        entity_type: "message",
        entity_id: messageRowId,
        metadata: {
          business_id: businessId,
          conversation_id: conversationId,
          contact_id: contactId,
          user_id: userId,
          error: sendErrorMessage,
        },
      });

      return jsonNoStore(
        {
          error: sendErrorMessage,
          message_id: messageRowId,
        },
        { status: 502 }
      );
    }
  } catch (error: unknown) {
    console.error("operator reply route error:", error);
    return jsonNoStore(
      {
        error: "Failed to send reply",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
