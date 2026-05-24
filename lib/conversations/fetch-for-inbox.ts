import type { SupabaseClient } from "@supabase/supabase-js";
import {
  postgrestMissingBusinessIdColumn,
  postgrestMissingColumn,
} from "@/lib/supabase-postgrest-errors";

export type InboxConversationRow = {
  id: string;
  status: string | null;
  contact_id: string | null;
  lead_id: string | null;
  last_message_at?: string | null;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

type ConvFetchAttempt = {
  select: string;
  orderColumn: string | null;
};

const ATTEMPTS: ConvFetchAttempt[] = [
  {
    select:
      "id, status, contact_id, lead_id, last_message_at, last_inbound_at, last_outbound_at",
    orderColumn: "last_message_at",
  },
  {
    select: "id, status, contact_id, lead_id, updated_at, created_at",
    orderColumn: "updated_at",
  },
  {
    select: "id, status, contact_id, lead_id, created_at",
    orderColumn: "created_at",
  },
  {
    select: "id, status, contact_id, lead_id",
    orderColumn: null,
  },
  { select: "id, contact_id, lead_id", orderColumn: null },
];

/**
 * Inbox/heuristic conversation list for one business. If `conversations.business_id`
 * is missing on the DB, falls back to the legacy unscoped query (same as pre-migration).
 */
export async function fetchConversationsForInbox(
  supabase: SupabaseClient,
  businessId: string
): Promise<InboxConversationRow[]> {
  async function runAttempts(withBizFilter: boolean): Promise<InboxConversationRow[] | null> {
    let lastColumnError: string | null = null;

    for (const attempt of ATTEMPTS) {
      let q = supabase.from("conversations").select(attempt.select).limit(100);
      if (withBizFilter) {
        q = q.eq("business_id", businessId);
      }
      if (attempt.orderColumn) {
        q = q.order(attempt.orderColumn, { ascending: false, nullsFirst: false });
      }

      const { data, error } = await q;

      if (!error) {
        return (data ?? []) as unknown as InboxConversationRow[];
      }

      if (withBizFilter && postgrestMissingBusinessIdColumn(error.message)) {
        return null;
      }

      if (postgrestMissingColumn(error.message)) {
        lastColumnError = error.message;
        continue;
      }

      throw new Error(error.message);
    }

    if (lastColumnError) {
      throw new Error(lastColumnError);
    }
    return [];
  }

  const scoped = await runAttempts(true);
  if (scoped !== null) {
    return scoped;
  }
  const legacy = await runAttempts(false);
  return legacy ?? [];
}

/**
 * Conversation ids for recent-activity style queries. Returns `null` if `business_id`
 * should not be filtered (column absent).
 */
export async function fetchConversationIdsScoped(
  supabase: SupabaseClient,
  businessId: string,
  limit: number
): Promise<string[] | null> {
  const attempts = [
    "last_message_at",
    "updated_at",
    "created_at",
  ] as const;

  for (const col of attempts) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id")
      .eq("business_id", businessId)
      .order(col, { ascending: false, nullsFirst: false })
      .limit(limit);

    if (!error) {
      return (data ?? []).map((r) => String((r as { id: string }).id));
    }
    if (postgrestMissingBusinessIdColumn(error.message)) {
      return null;
    }
    if (!postgrestMissingColumn(error.message)) {
      throw new Error(error.message);
    }
  }

  throw new Error("Could not list conversations for recent activity");
}
