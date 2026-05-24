import { ApiAuthError, requireBusinessUser } from "@/app/api/lib/require-auth";
import { refreshCampaignRollup } from "@/lib/campaigns/rollup";
import { logMessagingAudit } from "@/lib/messaging/audit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { UUID_RE, jsonNoStore } from "../../_http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  req: Request,
  context: { params: Promise<{ campaignId: string }> }
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

  const { campaignId } = await context.params;
  if (!campaignId || !UUID_RE.test(campaignId)) {
    return jsonNoStore({ error: "Invalid campaign id" }, { status: 400 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const payload = (body ?? {}) as { messageIds?: unknown };
  const filterIds =
    Array.isArray(payload.messageIds) && payload.messageIds.length > 0
      ? new Set(
          payload.messageIds.filter(
            (id): id is string => typeof id === "string" && UUID_RE.test(id)
          )
        )
      : null;

  const supabase = createSupabaseServiceRoleClient();

  const { data: campaign, error: cErr } = await supabase
    .from("campaigns")
    .select("id, name")
    .eq("id", campaignId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (cErr) {
    console.error("campaign approve fetch:", cErr.message);
    return jsonNoStore({ error: "Failed to load campaign" }, { status: 500 });
  }
  if (!campaign) {
    return jsonNoStore({ error: "Campaign not found" }, { status: 404 });
  }

  const { data: draftRows, error: qErr } = await supabase
    .from("campaign_messages")
    .select("id, status")
    .eq("campaign_id", campaignId)
    .eq("status", "draft");

  if (qErr) {
    console.error("campaign_messages approve list:", qErr.message);
    return jsonNoStore({ error: "Failed to load messages" }, { status: 500 });
  }

  const toApprove = (draftRows ?? []).filter(
    (r) => !filterIds || filterIds.has(r.id as string)
  );

  if (toApprove.length === 0) {
    return jsonNoStore(
      { error: "No draft messages matched for approval" },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();

  const { data: campaignBefore } = await supabase
    .from("campaigns")
    .select("approved_at")
    .eq("id", campaignId)
    .single();

  const ids = toApprove.map((r) => r.id as string);
  const { error: upErr } = await supabase
    .from("campaign_messages")
    .update({
      status: "approved",
      approved_at: now,
      updated_at: now,
    })
    .in("id", ids);

  if (upErr) {
    console.error("approve update:", upErr.message);
    return jsonNoStore({ error: "Failed to approve messages" }, { status: 500 });
  }

  const approveCampaign =
    !(campaignBefore?.approved_at as string | null | undefined);
  if (approveCampaign) {
    await supabase
      .from("campaigns")
      .update({ approved_at: now, updated_at: now })
      .eq("id", campaignId);
  }

  await refreshCampaignRollup(supabase, campaignId);

  await logMessagingAudit(supabase, {
    event_type: "campaign_messages_approved",
    entity_type: "campaign",
    entity_id: campaignId,
    metadata: {
      business_id: businessId,
      user_id: userId,
      message_ids: ids,
      count: ids.length,
    },
  });

  return jsonNoStore({
    ok: true,
    approved_count: ids.length,
  });
}
