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

type ConversationRow = {
  id: string;
  status: string | null;
  contact_id: string | null;
  needs_human?: boolean | null;
  human_takeover?: boolean | null;
  last_message_at?: string | null;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
  business_id?: string | null;
};

type ContactRow = {
  id: string;
  name: string | null;
  phone: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string | null;
  direction: string | null;
  message_text: string | null;
  created_at: string | null;
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

async function fetchConversationsForBusiness(
  supabase: SupabaseClient,
  businessId: string
): Promise<ConversationRow[]> {
  const selectWide =
    "id, status, contact_id, needs_human, human_takeover, last_message_at, last_inbound_at, last_outbound_at, business_id";
  const selectNarrow = "id, status, contact_id";

  const scoped = await supabase
    .from("conversations")
    .select(selectWide)
    .eq("business_id", businessId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(50);

  if (!scoped.error) {
    return (scoped.data ?? []) as ConversationRow[];
  }

  if (postgrestMissingBusinessIdColumn(scoped.error.message)) {
    const legacy = await supabase
      .from("conversations")
      .select(selectNarrow)
      .order("created_at", { ascending: false })
      .limit(50);
    if (legacy.error) throw new Error(legacy.error.message);
    return (legacy.data ?? []) as ConversationRow[];
  }

  if (isMissingColumnError(scoped.error.message)) {
    const fallback = await supabase
      .from("conversations")
      .select(selectNarrow)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (fallback.error) throw new Error(fallback.error.message);
    return (fallback.data ?? []) as ConversationRow[];
  }

  throw new Error(scoped.error.message);
}

function conversationSortKey(conv: ConversationRow): number {
  const raw =
    conv.last_message_at ?? conv.last_inbound_at ?? conv.last_outbound_at ?? null;
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

function needsHumanBadge(conv: ConversationRow, latestDirection: string | null): boolean {
  if (conv.needs_human === true || conv.human_takeover === true) return true;
  const st = (conv.status ?? "").toLowerCase();
  if (st.includes("needs_human") || st.includes("escalated")) return true;
  return (latestDirection ?? "").toLowerCase() === "inbound";
}

export async function GET() {
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

  try {
    const supabase = createSupabaseServiceRoleClient();
    let conversations = await fetchConversationsForBusiness(supabase, businessId);

    conversations = conversations.filter((conv) =>
      conversationAccessibleToBusiness(conv, businessId)
    );

    if (conversations.length === 0) {
      return jsonNoStore({
        generatedAt: new Date().toISOString(),
        conversations: [],
      });
    }

    conversations.sort((a, b) => conversationSortKey(b) - conversationSortKey(a));

    const conversationIds = conversations.map((c) => c.id);
    const contactIds = [
      ...new Set(
        conversations
          .map((c) => c.contact_id)
          .filter((id): id is string => Boolean(id))
      ),
    ];

    const [contactsResult, messagesResult] = await Promise.all([
      contactIds.length > 0
        ? supabase.from("contacts").select("id, name, phone").in("id", contactIds)
        : Promise.resolve({ data: [] as ContactRow[], error: null }),
      supabase
        .from("messages")
        .select("id, conversation_id, direction, message_text, created_at")
        .in("conversation_id", conversationIds)
        .order("created_at", { ascending: false })
        .limit(500),
    ]);

    if (contactsResult.error) throw new Error(contactsResult.error.message);
    if (messagesResult.error) throw new Error(messagesResult.error.message);

    const contactsById = new Map(
      ((contactsResult.data ?? []) as ContactRow[]).map((c) => [c.id, c])
    );

    const latestByConv = new Map<string, MessageRow>();
    for (const row of (messagesResult.data ?? []) as MessageRow[]) {
      const cid = row.conversation_id;
      if (!cid || latestByConv.has(cid)) continue;
      latestByConv.set(cid, row);
    }

    const list = conversations.map((conv) => {
      const contact = conv.contact_id ? contactsById.get(conv.contact_id) : null;
      const latest = latestByConv.get(conv.id);
      const lastDirection = latest?.direction ?? null;

      return {
        id: conv.id,
        contactName: contact?.name?.trim() || "Unknown contact",
        phoneMasked: maskPhoneForDisplay(contact?.phone),
        preview: latest?.message_text?.trim() || "(no messages yet)",
        lastMessageAt:
          latest?.created_at ??
          conv.last_message_at ??
          conv.last_inbound_at ??
          null,
        lastDirection,
        needsHuman: needsHumanBadge(conv, lastDirection),
        status: conv.status,
      };
    });

    return jsonNoStore({
      generatedAt: new Date().toISOString(),
      conversations: list,
    });
  } catch (error) {
    return jsonNoStore(
      {
        error: "Failed to load recent conversations",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
