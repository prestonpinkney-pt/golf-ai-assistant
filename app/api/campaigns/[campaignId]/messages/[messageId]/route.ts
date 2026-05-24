import { ApiAuthError, requireBusinessUser } from "@/app/api/lib/require-auth";
import { refreshCampaignRollup } from "@/lib/campaigns/rollup";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { UUID_RE, jsonNoStore } from "../../../_http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_MESSAGE_LENGTH = 1600;

const ALLOWED_STATUS = new Set(["draft", "approved"]);

export async function PATCH(
  req: Request,
  context: {
    params: Promise<{ campaignId: string; messageId: string }>;
  }
) {
  let businessId: string;
  try {
    businessId = (await requireBusinessUser()).businessId;
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return jsonNoStore({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const { campaignId, messageId } = await context.params;
  if (!campaignId || !UUID_RE.test(campaignId)) {
    return jsonNoStore({ error: "Invalid campaign id" }, { status: 400 });
  }
  if (!messageId || !UUID_RE.test(messageId)) {
    return jsonNoStore({ error: "Invalid message id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as {
    message_text?: unknown;
    status?: unknown;
  };

  const supabase = createSupabaseServiceRoleClient();

  const { data: campaign, error: cErr } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (cErr || !campaign) {
    return jsonNoStore({ error: "Campaign not found" }, { status: 404 });
  }

  const { data: row, error: mErr } = await supabase
    .from("campaign_messages")
    .select("id, status, message_text")
    .eq("id", messageId)
    .eq("campaign_id", campaignId)
    .maybeSingle();

  if (mErr || !row) {
    return jsonNoStore({ error: "Message not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (payload.message_text !== undefined) {
    if ((row.status as string) !== "draft") {
      return jsonNoStore(
        { error: "Only draft messages can be edited" },
        { status: 409 }
      );
    }
    const text =
      typeof payload.message_text === "string" ? payload.message_text.trim() : "";
    if (!text) {
      return jsonNoStore({ error: "message_text cannot be empty" }, { status: 400 });
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      return jsonNoStore(
        { error: `message_text must be <= ${MAX_MESSAGE_LENGTH} characters` },
        { status: 400 }
      );
    }
    updates.message_text = text;
  }

  if (payload.status !== undefined) {
    const st =
      typeof payload.status === "string" ? payload.status.trim() : "";
    if (!ALLOWED_STATUS.has(st)) {
      return jsonNoStore(
        { error: "status must be draft or approved" },
        { status: 400 }
      );
    }
    const cur = row.status as string;
    if (st === "draft" && cur !== "approved") {
      return jsonNoStore(
        { error: "Only approved rows can revert to draft" },
        { status: 409 }
      );
    }
    if (st === "approved" && cur !== "draft") {
      return jsonNoStore(
        { error: "Only draft rows can be marked approved via PATCH" },
        { status: 409 }
      );
    }
    updates.status = st;
    if (st === "approved") {
      updates.approved_at = new Date().toISOString();
    }
    if (st === "draft") {
      updates.approved_at = null;
    }
  }

  if (Object.keys(updates).length <= 1) {
    return jsonNoStore({ error: "No updates supplied" }, { status: 400 });
  }

  const { data: updated, error: uErr } = await supabase
    .from("campaign_messages")
    .update(updates)
    .eq("id", messageId)
    .select()
    .single();

  if (uErr || !updated) {
    console.error("campaign message patch:", uErr?.message);
    return jsonNoStore({ error: "Failed to update message" }, { status: 500 });
  }

  try {
    await refreshCampaignRollup(supabase, campaignId);
  } catch (e) {
    console.error("refreshCampaignRollup:", e);
  }

  return jsonNoStore({ ok: true, message: updated });
}
