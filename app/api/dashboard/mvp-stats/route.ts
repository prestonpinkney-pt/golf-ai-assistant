import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUSINESS_ID } from "@/app/api/config";
import { loadOutboundOpportunityTargets } from "@/app/api/lib/opportunity-eligible-targets";
import { ApiAuthError, requireBusinessUser } from "@/app/api/lib/require-auth";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

type ConversationRow = {
  id: string;
  status: string | null;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
};

type MessageRow = {
  conversation_id: string | null;
  direction: string | null;
  delivery_status?: string | null;
  status?: string | null;
  created_at: string | null;
};

const RECOVERY_OPPORTUNITIES = new Set([
  "booking_cancelled_recovery",
  "inactive_customer_reactivation",
]);

function isMissingColumnError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("column") && (m.includes("does not exist") || m.includes("could not find"));
}

function conversationNeedsReply(
  conv: ConversationRow,
  latestDirection: string | null,
  hasFailedDelivery: boolean
): boolean {
  if (hasFailedDelivery) return true;
  if ((latestDirection ?? "").toLowerCase() === "inbound") return true;

  const st = (conv.status ?? "").toLowerCase().replace(/_/g, " ");
  if (st.includes("needs human") || st.includes("needs_human") || st === "escalated") {
    return true;
  }

  const li = conv.last_inbound_at ? Date.parse(conv.last_inbound_at) : NaN;
  const lo = conv.last_outbound_at ? Date.parse(conv.last_outbound_at) : NaN;
  if (!Number.isNaN(li) && (Number.isNaN(lo) || li > lo)) return true;

  return false;
}

function normalizeConversationRows(data: unknown): ConversationRow[] {
  if (!Array.isArray(data)) return [];

  return data.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : String(record.id ?? "");
    if (!id) return [];

    return [
      {
        id,
        status: typeof record.status === "string" ? record.status : null,
        last_inbound_at:
          typeof record.last_inbound_at === "string" ? record.last_inbound_at : null,
        last_outbound_at:
          typeof record.last_outbound_at === "string" ? record.last_outbound_at : null,
      },
    ];
  });
}

async function fetchConversations(
  supabase: SupabaseClient,
  businessId: string
): Promise<ConversationRow[]> {
  const selectAttempts = [
    "id, status, last_inbound_at, last_outbound_at",
    "id, status",
  ];

  for (const select of selectAttempts) {
    const scoped = await supabase
      .from("conversations")
      .select(select)
      .eq("business_id", businessId)
      .limit(200);

    if (!scoped.error) {
      return normalizeConversationRows(scoped.data);
    }
    if (isMissingColumnError(scoped.error.message)) {
      if (select === selectAttempts[0]) {
        continue;
      }
      const legacy = await supabase.from("conversations").select(select).limit(200);
      if (!legacy.error) {
        return normalizeConversationRows(legacy.data);
      }
      if (isMissingColumnError(legacy.error.message)) continue;
      throw new Error(legacy.error.message);
    }
    throw new Error(scoped.error.message);
  }

  return [];
}

async function countInboxAttention(
  supabase: SupabaseClient,
  businessId: string
): Promise<number> {
  const conversations = await fetchConversations(supabase, businessId);
  const ids = conversations.map((c) => c.id).filter(Boolean);
  if (ids.length === 0) return 0;

  const { data: messageRows, error } = await supabase
    .from("messages")
    .select("conversation_id, direction, delivery_status, status, created_at")
    .in("conversation_id", ids)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  const latestByConv = new Map<string, MessageRow>();
  for (const row of (messageRows ?? []) as MessageRow[]) {
    const cid = row.conversation_id;
    if (!cid || latestByConv.has(cid)) continue;
    latestByConv.set(cid, row);
  }

  const failedIds = new Set<string>();
  for (const row of (messageRows ?? []) as MessageRow[]) {
    const cid = row.conversation_id;
    if (!cid) continue;
    const delivery = (row.delivery_status ?? "").toLowerCase();
    const status = (row.status ?? "").toLowerCase();
    if (delivery === "failed" || status === "failed") {
      failedIds.add(cid);
    }
  }

  let count = 0;
  for (const conv of conversations) {
    const latest = latestByConv.get(conv.id);
    if (
      conversationNeedsReply(
        conv,
        latest?.direction ?? null,
        failedIds.has(conv.id)
      )
    ) {
      count += 1;
    }
  }
  return count;
}

export async function GET() {
  let businessId: string;
  try {
    businessId = (await requireBusinessUser()).businessId;
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode, headers: NO_STORE });
    }
    throw e;
  }

  try {
    const supabase = createSupabaseServiceRoleClient();
    const scopedBusinessId = businessId || BUSINESS_ID;

    const [targets, inboxAttentionCount] = await Promise.all([
      loadOutboundOpportunityTargets({
        supabase,
        businessId: scopedBusinessId,
      }),
      countInboxAttention(supabase, scopedBusinessId),
    ]);

    const opportunityCount = targets.length;
    const recoveryQueueCount = targets.filter((t) =>
      RECOVERY_OPPORTUNITIES.has(t.recognizedOpportunity)
    ).length;

    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        opportunityCount,
        inboxAttentionCount,
        recoveryQueueCount,
      },
      { headers: NO_STORE }
    );
  } catch (e) {
    console.error("[dashboard/mvp-stats]", e);
    return NextResponse.json(
      {
        error: "Failed to load dashboard stats",
        details: e instanceof Error ? e.message : String(e),
      },
      { status: 500, headers: NO_STORE }
    );
  }
}
