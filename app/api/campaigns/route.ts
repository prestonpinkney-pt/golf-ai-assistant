import { ApiAuthError, requireBusinessUser } from "@/app/api/lib/require-auth";
import { loadOutboundOpportunityTargets } from "@/app/api/lib/opportunity-eligible-targets";
import { refreshCampaignRollup } from "@/lib/campaigns/rollup";
import {
  postgrestMissingColumn,
  postgrestMissingTable,
} from "@/lib/supabase-postgrest-errors";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { jsonNoStore, errorMessage } from "./_http";
import { CAMPAIGNS_SETUP_MESSAGE } from "./setup-copy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_TARGETS = 100;

export { CAMPAIGNS_SETUP_MESSAGE };

const CAMPAIGNS_SELECT_FULL =
  "id, business_id, name, campaign_type, playbook_key, status, source, total_recipients, total_drafted, total_approved, total_sent, total_failed, created_at, updated_at, approved_at, sent_at, metadata";

const CAMPAIGNS_SELECT_MINIMAL =
  "id, business_id, name, playbook_key, status, total_recipients, total_drafted, total_approved, total_sent, total_failed, created_at, updated_at";

async function listCampaignsForBusiness(
  supabase: ReturnType<typeof createSupabaseServiceRoleClient>,
  businessId: string
): Promise<
  | { ok: true; campaigns: unknown[]; setupRequired: boolean }
  | { ok: false; message: string }
> {
  const attempts = [CAMPAIGNS_SELECT_FULL, CAMPAIGNS_SELECT_MINIMAL];
  let lastMsg = "";

  for (const sel of attempts) {
    const { data, error } = await supabase
      .from("campaigns")
      .select(sel)
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });

    if (!error) {
      return { ok: true, campaigns: data ?? [], setupRequired: false };
    }

    lastMsg = error.message;
    if (postgrestMissingTable(error.message, "campaigns")) {
      return { ok: true, campaigns: [], setupRequired: true };
    }
    if (postgrestMissingColumn(error.message)) {
      continue;
    }
    return { ok: false, message: error.message };
  }

  return { ok: false, message: lastMsg || "Failed to load campaigns" };
}

export async function GET() {
  let businessId: string;
  try {
    businessId = (await requireBusinessUser()).businessId;
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return jsonNoStore({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const supabase = createSupabaseServiceRoleClient();
  const result = await listCampaignsForBusiness(supabase, businessId);

  if (!result.ok) {
    console.error("campaigns list error:", result.message);
    return jsonNoStore({ error: "Failed to load campaigns" }, { status: 500 });
  }

  if (result.setupRequired) {
    return jsonNoStore({
      campaigns: [],
      setupRequired: true,
      setupMessage: CAMPAIGNS_SETUP_MESSAGE,
    });
  }

  return jsonNoStore({
    campaigns: result.campaigns,
    setupRequired: false,
  });
}

export async function POST(req: Request) {
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as {
    name?: unknown;
    playbook_key?: unknown;
    campaignName?: unknown;
    targetIds?: unknown;
  };

  const targetIdsRaw = payload.targetIds;
  if (!Array.isArray(targetIdsRaw) || targetIdsRaw.length === 0) {
    return jsonNoStore(
      { error: "targetIds must be a non-empty array of opportunity ids" },
      { status: 400 }
    );
  }

  const targetIdSet = new Set(
    targetIdsRaw
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((id) => id.trim())
  );

  if (targetIdSet.size === 0) {
    return jsonNoStore({ error: "No valid target ids" }, { status: 400 });
  }

  if (targetIdSet.size > MAX_TARGETS) {
    return jsonNoStore(
      { error: `At most ${MAX_TARGETS} targets per campaign` },
      { status: 400 }
    );
  }

  const supabase = createSupabaseServiceRoleClient();

  let targets;
  try {
    targets = await loadOutboundOpportunityTargets({
      supabase,
      businessId,
    });
  } catch (err) {
    console.error("loadOutboundOpportunityTargets:", err);
    return jsonNoStore(
      { error: errorMessage(err, "Failed to load targets") },
      { status: 500 }
    );
  }

  const picked = targets.filter((t) => targetIdSet.has(t.opportunityId));
  if (picked.length === 0) {
    return jsonNoStore(
      { error: "No matching opportunity targets for this workspace" },
      { status: 404 }
    );
  }

  const campaignNameFromPayload =
    typeof payload.name === "string" && payload.name.trim()
      ? payload.name.trim()
      : typeof payload.campaignName === "string" && payload.campaignName.trim()
        ? payload.campaignName.trim()
        : null;

  const playbookKey =
    typeof payload.playbook_key === "string" && payload.playbook_key.trim()
      ? payload.playbook_key.trim()
      : picked[0]?.playbook ?? null;

  const defaultName =
    campaignNameFromPayload ??
    `${picked[0]?.recommendedCampaign || "Campaign"} · ${new Date().toISOString().slice(0, 10)}`;

  const { data: campaign, error: cErr } = await supabase
    .from("campaigns")
    .insert({
      business_id: businessId,
      name: defaultName,
      campaign_type: "outbound_sms",
      playbook_key: playbookKey,
      status: "draft",
      source: "opportunity_playbook",
      created_by: userId,
      metadata: {
        recommended_campaign: picked[0]?.recommendedCampaign ?? null,
      },
    })
    .select()
    .single();

  if (cErr || !campaign) {
    console.error("campaign insert:", cErr?.message);
    if (cErr && postgrestMissingTable(cErr.message, "campaigns")) {
      return jsonNoStore(
        {
          error: CAMPAIGNS_SETUP_MESSAGE,
          setupRequired: true,
        },
        { status: 503 }
      );
    }
    return jsonNoStore({ error: "Failed to create campaign" }, { status: 500 });
  }

  const campaignId = campaign.id as string;

  const messageRows = picked.map((t) => ({
    campaign_id: campaignId,
    opportunity_id: t.opportunityId,
    phone: t.phone,
    contact_name: t.leadName,
    message_text: t.recommendedMessage ?? "",
    status: "draft" as const,
    metadata: {
      customer_profile_id: t.customerProfileId,
      playbook: t.playbook,
      recommended_channel: t.recommendedChannel,
      recommended_campaign: t.recommendedCampaign,
    },
  }));

  const { error: mErr } = await supabase.from("campaign_messages").insert(messageRows);

  if (mErr) {
    console.error("campaign_messages insert:", mErr.message);
    await supabase.from("campaigns").delete().eq("id", campaignId);
    if (postgrestMissingTable(mErr.message, "campaign_messages")) {
      return jsonNoStore(
        {
          error: CAMPAIGNS_SETUP_MESSAGE,
          setupRequired: true,
        },
        { status: 503 }
      );
    }
    return jsonNoStore({ error: "Failed to create campaign messages" }, { status: 500 });
  }

  try {
    await refreshCampaignRollup(supabase, campaignId);
  } catch (rollupErr) {
    console.error("refreshCampaignRollup:", rollupErr);
  }

  const { data: full, error: fullErr } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();

  if (fullErr || !full) {
    return jsonNoStore({ ok: true, campaign_id: campaignId });
  }

  return jsonNoStore({ ok: true, campaign: full });
}
