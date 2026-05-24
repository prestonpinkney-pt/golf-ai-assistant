import { ApiAuthError, requireBusinessUser } from "@/app/api/lib/require-auth";
import {
  postgrestMissingColumn,
  postgrestMissingTable,
} from "@/lib/supabase-postgrest-errors";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { UUID_RE, jsonNoStore } from "../_http";
import { CAMPAIGNS_SETUP_MESSAGE } from "../setup-copy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function loadCampaignMessages(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  campaignId: string
) {
  const attempts = ["*", "id, campaign_id, contact_name, phone, message_text, status, delivery_status, created_at"];
  let lastErr = "";
  for (const sel of attempts) {
    const { data, error } = await supabase
      .from("campaign_messages")
      .select(sel)
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: true });
    if (!error) {
      return { data: data ?? [], error: null as string | null };
    }
    lastErr = error.message;
    if (postgrestMissingTable(error.message, "campaign_messages")) {
      return { data: [], error: "setup" as const };
    }
    if (postgrestMissingColumn(error.message)) {
      continue;
    }
    return { data: [], error: error.message };
  }
  return { data: [], error: lastErr };
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ campaignId: string }> }
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

  const { campaignId } = await context.params;
  if (!campaignId || !UUID_RE.test(campaignId)) {
    return jsonNoStore({ error: "Invalid campaign id" }, { status: 400 });
  }

  const supabase = createSupabaseServiceRoleClient();

  const { data: campaign, error: cErr } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (cErr) {
    console.error("campaign get:", cErr.message);
    if (postgrestMissingTable(cErr.message, "campaigns")) {
      return jsonNoStore(
        {
          error: "setup_required",
          setupMessage: CAMPAIGNS_SETUP_MESSAGE,
        },
        { status: 503 }
      );
    }
    return jsonNoStore({ error: "Failed to load campaign" }, { status: 500 });
  }

  if (!campaign) {
    return jsonNoStore({ error: "Campaign not found" }, { status: 404 });
  }

  const msgResult = await loadCampaignMessages(supabase, campaignId);

  if (msgResult.error === "setup") {
    return jsonNoStore(
      {
        error: "setup_required",
        setupMessage: CAMPAIGNS_SETUP_MESSAGE,
        campaign,
        messages: [],
      },
      { status: 503 }
    );
  }

  if (msgResult.error) {
    console.error("campaign_messages list:", msgResult.error);
    return jsonNoStore({ error: "Failed to load campaign messages" }, { status: 500 });
  }

  return jsonNoStore({
    campaign,
    messages: msgResult.data,
  });
}
