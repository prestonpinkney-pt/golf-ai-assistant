import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiAuthError, requireBusinessUser } from "@/app/api/lib/require-auth";
import { conversationAccessibleToBusiness } from "@/lib/conversations/conversation-tenant";
import { maskPhoneForDisplay } from "@/lib/messaging/phone";
import { postgrestMissingBusinessIdColumn } from "@/lib/supabase-postgrest-errors";
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

const MESSAGE_SELECT_WIDE =
  "id, direction, channel, message_text, body, status, delivery_status, ai_generated, ai_confidence, intent, risk_level, escalation_required, escalation_reason, created_at, sent_at, delivery_updated_at, sender_type, provider, metadata";

const MESSAGE_SELECT_NARROW =
  "id, direction, channel, message_text, body, status, delivery_status, ai_generated, intent, created_at, sent_at, sender_type, provider, metadata";

type ConversationDetail = {
  id: string;
  status: string | null;
  needs_human?: boolean | null;
  human_takeover?: boolean | null;
  escalation_reason?: string | null;
  automation_enabled?: boolean | null;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
  contact_id: string | null;
  business_id?: string | null;
};

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...NO_STORE_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function isMissingColumnError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("column") && (m.includes("does not exist") || m.includes("could not find"));
}

function sendBlockedReason(contact: {
  sms_opt_out?: boolean | null;
  cooling_off_until?: string | null;
}): string | null {
  if (contact.sms_opt_out) {
    return "Contact has opted out of SMS. Sending and AI drafts are blocked.";
  }
  if (
    contact.cooling_off_until &&
    new Date(contact.cooling_off_until) > new Date()
  ) {
    return "Contact is in a cooling-off period. Sending is temporarily blocked.";
  }
  return null;
}

async function loadConversation(
  supabase: SupabaseClient,
  conversationId: string
): Promise<{ data: ConversationDetail | null; error: string | null }> {
  const selectWide =
    "id, status, contact_id, needs_human, human_takeover, escalation_reason, automation_enabled, last_inbound_at, last_outbound_at, business_id";
  const selectNarrow = "id, status, contact_id";

  const wide = await supabase
    .from("conversations")
    .select(selectWide)
    .eq("id", conversationId)
    .maybeSingle();

  if (!wide.error && wide.data) {
    return { data: wide.data as ConversationDetail, error: null };
  }

  if (
    wide.error &&
    (postgrestMissingBusinessIdColumn(wide.error.message) ||
      isMissingColumnError(wide.error.message))
  ) {
    const narrow = await supabase
      .from("conversations")
      .select(selectNarrow)
      .eq("id", conversationId)
      .maybeSingle();
    if (narrow.error) return { data: null, error: narrow.error.message };
    return { data: (narrow.data as ConversationDetail | null) ?? null, error: null };
  }

  if (wide.error) return { data: null, error: wide.error.message };
  return { data: null, error: null };
}

async function loadMessages(
  supabase: SupabaseClient,
  conversationId: string
) {
  const wide = await supabase
    .from("messages")
    .select(MESSAGE_SELECT_WIDE)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (!wide.error) return wide.data ?? [];

  if (isMissingColumnError(wide.error.message)) {
    const narrow = await supabase
      .from("messages")
      .select(MESSAGE_SELECT_NARROW)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (narrow.error) throw new Error(narrow.error.message);
    return narrow.data ?? [];
  }

  throw new Error(wide.error.message);
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  let businessId: string;
  try {
    const ctx = await requireBusinessUser();
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

  try {
    const supabase = createSupabaseServiceRoleClient();
    const { data: conversation, error: convError } = await loadConversation(
      supabase,
      conversationId
    );

    if (convError) throw new Error(convError);
    if (!conversation) {
      return jsonNoStore({ error: "Conversation not found" }, { status: 404 });
    }

    if (!conversationAccessibleToBusiness(conversation, businessId)) {
      return jsonNoStore({ error: "Conversation not found" }, { status: 404 });
    }

    const contactId = conversation.contact_id;
    if (!contactId) {
      return jsonNoStore(
        { error: "Conversation has no linked contact" },
        { status: 422 }
      );
    }

    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("id, name, phone, sms_opt_out, cooling_off_until")
      .eq("id", contactId)
      .maybeSingle();

    if (contactError) throw new Error(contactError.message);
    if (!contact) {
      return jsonNoStore({ error: "Contact not found" }, { status: 404 });
    }

    const messages = await loadMessages(supabase, conversationId);
    const blocked = sendBlockedReason(contact);

    return jsonNoStore({
      conversation: {
        id: conversation.id,
        status: conversation.status,
        needsHuman:
          conversation.needs_human === true ||
          conversation.human_takeover === true,
        escalationReason: conversation.escalation_reason ?? null,
        automationEnabled: conversation.automation_enabled !== false,
        lastInboundAt: conversation.last_inbound_at ?? null,
        lastOutboundAt: conversation.last_outbound_at ?? null,
      },
      contact: {
        id: contact.id,
        name: contact.name?.trim() || "Unknown contact",
        phoneMasked: maskPhoneForDisplay(
          typeof contact.phone === "string" ? contact.phone : null
        ),
        smsOptOut: Boolean(contact.sms_opt_out),
        coolingOffActive: Boolean(
          contact.cooling_off_until &&
            new Date(contact.cooling_off_until as string) > new Date()
        ),
        sendBlockedReason: blocked,
      },
      messages: messages.map((row) => {
        const r = row as Record<string, unknown>;
        const metadata =
          r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
            ? (r.metadata as Record<string, unknown>)
            : {};
        return {
          id: String(r.id),
          direction: typeof r.direction === "string" ? r.direction : "unknown",
          channel: typeof r.channel === "string" ? r.channel : null,
          body:
            (typeof r.message_text === "string" && r.message_text) ||
            (typeof r.body === "string" && r.body) ||
            "",
          status: typeof r.status === "string" ? r.status : null,
          deliveryStatus:
            typeof r.delivery_status === "string" ? r.delivery_status : null,
          aiGenerated: r.ai_generated === true,
          intent: typeof r.intent === "string" ? r.intent : null,
          riskLevel: typeof r.risk_level === "string" ? r.risk_level : null,
          escalationRequired: r.escalation_required === true,
          escalationReason:
            typeof r.escalation_reason === "string" ? r.escalation_reason : null,
          senderType: typeof r.sender_type === "string" ? r.sender_type : null,
          provider: typeof r.provider === "string" ? r.provider : null,
          createdAt: typeof r.created_at === "string" ? r.created_at : null,
          sentAt: typeof r.sent_at === "string" ? r.sent_at : null,
          deliveryUpdatedAt:
            typeof r.delivery_updated_at === "string"
              ? r.delivery_updated_at
              : null,
          metadataEscalation:
            metadata.escalation_required === true ||
            metadata.gate_reason != null,
        };
      }),
    });
  } catch (error) {
    return jsonNoStore(
      {
        error: "Failed to load conversation",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
