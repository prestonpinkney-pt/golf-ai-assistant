import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { gateBusinessUser } from "../../lib/require-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

type MessageRow = {
  id: string;
  conversation_id: string | null;
  contact_id: string | null;
  direction: string | null;
  message_text: string | null;
  status: string | null;
  created_at: string | null;
};

type ContactRow = {
  id: string;
  name: string | null;
};

type ConversationRow = {
  id: string;
  status: string | null;
};

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...NO_STORE_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function uniqueNonNull(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export async function GET() {
  const denied = await gateBusinessUser();
  if (denied) return denied;

  try {
    const supabase = getSupabaseAdmin();
    const { data: messageRows, error: messageError } = await supabase
      .from("messages")
      .select("id, conversation_id, contact_id, direction, message_text, status, created_at")
      .order("created_at", { ascending: false })
      .limit(12);

    if (messageError) throw new Error(messageError.message);

    const messages = (messageRows ?? []) as MessageRow[];
    const contactIds = uniqueNonNull(messages.map((message) => message.contact_id));
    const conversationIds = uniqueNonNull(messages.map((message) => message.conversation_id));

    const [contactsResult, conversationsResult] = await Promise.all([
      contactIds.length > 0
        ? supabase.from("contacts").select("id, name").in("id", contactIds)
        : Promise.resolve({ data: [] as ContactRow[], error: null }),
      conversationIds.length > 0
        ? supabase.from("conversations").select("id, status").in("id", conversationIds)
        : Promise.resolve({ data: [] as ConversationRow[], error: null }),
    ]);

    if (contactsResult.error) throw new Error(contactsResult.error.message);
    if (conversationsResult.error) throw new Error(conversationsResult.error.message);

    const contactsById = new Map(
      ((contactsResult.data ?? []) as ContactRow[]).map((contact) => [contact.id, contact])
    );
    const conversationsById = new Map(
      ((conversationsResult.data ?? []) as ConversationRow[]).map((conversation) => [
        conversation.id,
        conversation,
      ])
    );

    return jsonNoStore({
      generatedAt: new Date().toISOString(),
      conversations: messages.slice(0, 4).map((message) => {
        const contact = message.contact_id ? contactsById.get(message.contact_id) : null;
        const conversation = message.conversation_id
          ? conversationsById.get(message.conversation_id)
          : null;
        return {
          id: message.conversation_id ?? message.id,
          contactName: contact?.name?.trim() || "Unknown contact",
          preview: message.message_text ?? "",
          direction: message.direction ?? "inbound",
          status: conversation?.status ?? message.status ?? null,
          lastMessageAt: message.created_at,
        };
      }),
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
