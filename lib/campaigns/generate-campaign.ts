import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadOutboundOpportunityTargets,
  type OutboundOpportunityTarget,
} from "@/app/api/lib/opportunity-eligible-targets";
import {
  campaignFocusLabel,
  filterTargetsByCampaignFocus,
  type CampaignFocus,
} from "@/lib/campaigns/campaign-focus";
import { refreshCampaignRollup } from "@/lib/campaigns/rollup";
import {
  postgrestMissingTable,
} from "@/lib/supabase-postgrest-errors";
import { isLikelyE164Phone } from "./send-eligibility";
import {
  buildCampaignsSetupMessage,
  diagnoseCampaignsPostgrestError,
  type CampaignsMissingPiece,
} from "./setup-diagnostics";

const DEFAULT_MAX_TARGETS = 25;

export type GenerateAiCampaignDraftInput = {
  supabase: SupabaseClient;
  businessId: string;
  userId: string;
  maxTargets?: number;
  playbookKey?: string;
  campaignFocus?: CampaignFocus;
  loadTargets?: typeof loadOutboundOpportunityTargets;
};

export type GenerateAiCampaignDraftSuccess = {
  ok: true;
  campaign: Record<string, unknown>;
  messagesCreated: number;
  targetsConsidered: number;
  generationReason: string;
  emptyReason: null;
};

export type GenerateAiCampaignDraftFailure = {
  ok: false;
  reason:
    | "no_targets"
    | "setup_required"
    | "migration_missing"
    | "generation_failed"
    | "whoosh_availability_required";
  errorCode?: "whoosh_availability_required";
  message?: string;
  emptyReason?: string;
  setupMessage?: string;
  missing?: CampaignsMissingPiece[];
  error?: string;
};

export type GenerateAiCampaignDraftResult =
  | GenerateAiCampaignDraftSuccess
  | GenerateAiCampaignDraftFailure;

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function targetGroupKey(t: OutboundOpportunityTarget): string {
  const campaign = t.recommendedCampaign?.trim();
  if (campaign) return `campaign:${campaign}`;
  const playbook = t.playbook?.trim();
  if (playbook) return `playbook:${playbook}`;
  return "general";
}

function groupPriorityScore(targets: OutboundOpportunityTarget[]): number {
  return targets.reduce(
    (sum, t) => sum + (t.estimatedRevenueCents ?? 0) + (t.targetScore ?? 0),
    0
  );
}

export function pickAiCampaignTargetGroup(
  targets: OutboundOpportunityTarget[],
  playbookKey?: string
): {
  picked: OutboundOpportunityTarget[];
  generationReason: string;
  groupLabel: string;
} {
  const eligible = targets.filter(
    (t) =>
      typeof t.opportunityId === "string" &&
      t.opportunityId.trim().length > 0 &&
      isLikelyE164Phone(t.phone)
  );

  const filtered =
    playbookKey?.trim()
      ? eligible.filter((t) => t.playbook?.trim() === playbookKey.trim())
      : eligible;

  if (filtered.length === 0) {
    return {
      picked: [],
      generationReason: "",
      groupLabel: "CloseOS AI Campaign",
    };
  }

  const groups = new Map<string, OutboundOpportunityTarget[]>();
  for (const t of filtered) {
    const key = targetGroupKey(t);
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  let bestKey = "";
  let bestScore = -1;
  for (const [key, group] of groups) {
    const score = groupPriorityScore(group);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }

  const bestGroup = groups.get(bestKey) ?? [];
  const sorted = [...bestGroup].sort(
    (a, b) => (b.targetScore ?? 0) - (a.targetScore ?? 0)
  );

  const groupLabel =
    sorted[0]?.recommendedCampaign?.trim() ||
    sorted[0]?.playbook?.trim() ||
    "CloseOS AI Campaign";

  const generationReason =
    `Selected ${sorted.length} target(s) from "${groupLabel}" ` +
    `(priority score ${bestScore}; grouped by recommended campaign/playbook).`;

  return {
    picked: sorted,
    generationReason,
    groupLabel,
  };
}

function campaignNameFromGroup(groupLabel: string) {
  return `${groupLabel} · ${todayIsoDate()}`;
}

function setupFailureFromPostgrest(message: string): GenerateAiCampaignDraftFailure {
  const diagnosis = diagnoseCampaignsPostgrestError(message);
  const missing = diagnosis.missing;
  const setupMessage = buildCampaignsSetupMessage(missing);
  const reason =
    missing.includes("campaigns") || missing.includes("campaign_messages")
      ? "migration_missing"
      : "setup_required";

  return {
    ok: false,
    reason,
    setupMessage,
    missing,
    error: setupMessage,
  };
}

export async function generateAiCampaignDraft(
  input: GenerateAiCampaignDraftInput
): Promise<GenerateAiCampaignDraftResult> {
  const maxTargets = input.maxTargets ?? DEFAULT_MAX_TARGETS;
  const loadTargets = input.loadTargets ?? loadOutboundOpportunityTargets;
  const campaignFocus = input.campaignFocus ?? "best";

  let allTargets: OutboundOpportunityTarget[];
  try {
    allTargets = await loadTargets({
      supabase: input.supabase,
      businessId: input.businessId,
    });
  } catch (err) {
    console.error("[generateAiCampaignDraft] load targets failed:", err);
    return {
      ok: false,
      reason: "generation_failed",
      error: err instanceof Error ? err.message : "Failed to load opportunity targets",
    };
  }

  const focusFiltered = filterTargetsByCampaignFocus(allTargets, campaignFocus);

  if (campaignFocus === "slow_time" && focusFiltered.length === 0) {
    return {
      ok: false,
      reason: "whoosh_availability_required",
      errorCode: "whoosh_availability_required",
      message:
        "Whoosh availability is required before generating slow-time campaigns.",
      emptyReason:
        "Whoosh availability is required before generating slow-time campaigns.",
    };
  }

  const { picked, generationReason, groupLabel } = pickAiCampaignTargetGroup(
    focusFiltered,
    input.playbookKey
  );

  if (picked.length === 0) {
    const emptyReason =
      campaignFocus === "simulator"
        ? "No Whoosh-verified simulator opportunities with valid phones were found. Sync Whoosh availability first."
        : campaignFocus === "lessons"
          ? "No lesson opportunities with valid phones were found."
          : "No eligible campaign targets with valid phones were found. Run Square sync and revenue recovery first.";

    return {
      ok: false,
      reason: "no_targets",
      emptyReason,
    };
  }

  const selected = picked.slice(0, maxTargets);
  const focusLabel = campaignFocusLabel(campaignFocus);
  const playbookKey =
    input.playbookKey?.trim() || selected[0]?.playbook?.trim() || null;
  const campaignName =
    campaignFocus === "best"
      ? campaignNameFromGroup(groupLabel)
      : `${focusLabel} · ${todayIsoDate()}`;

  const whooshBacked = selected.some((t) => t.availabilityVerified === true);
  const focusGenerationReason =
    campaignFocus === "best"
      ? generationReason
      : `${generationReason} Campaign focus: ${focusLabel}${whooshBacked ? " (Whoosh-verified availability)." : "."}`;

  const { data: campaign, error: cErr } = await input.supabase
    .from("campaigns")
    .insert({
      business_id: input.businessId,
      name: campaignName,
      campaign_type: "outbound_sms",
      playbook_key: playbookKey,
      status: "draft",
      source: "ai_generated",
      created_by: input.userId,
      metadata: {
        generation_reason: focusGenerationReason,
        recommended_campaign: selected[0]?.recommendedCampaign ?? null,
        playbook: playbookKey,
        campaign_focus: campaignFocus,
        availability_source: whooshBacked ? "whoosh" : null,
        availability_verified: whooshBacked,
        targets_considered: focusFiltered.length,
        targets_selected: selected.length,
        generated_at: new Date().toISOString(),
      },
    })
    .select()
    .single();

  if (cErr || !campaign) {
    console.error("[generateAiCampaignDraft] campaign insert failed:", cErr?.message);
    if (cErr && postgrestMissingTable(cErr.message, "campaigns")) {
      return setupFailureFromPostgrest(cErr.message);
    }
    return {
      ok: false,
      reason: "generation_failed",
      error: cErr?.message ?? "Failed to create campaign",
    };
  }

  const campaignId = campaign.id as string;

  const messageRows = selected.map((t) => ({
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
      follow_up_plan: t.followUpPlan,
      estimated_revenue_cents: t.estimatedRevenueCents,
      reason: t.reason,
      target_score: t.targetScore,
    },
  }));

  const { error: mErr } = await input.supabase
    .from("campaign_messages")
    .insert(messageRows);

  if (mErr) {
    console.error("[generateAiCampaignDraft] campaign_messages insert failed:", mErr.message);
    await input.supabase.from("campaigns").delete().eq("id", campaignId);
    if (postgrestMissingTable(mErr.message, "campaign_messages")) {
      return setupFailureFromPostgrest(mErr.message);
    }
    return {
      ok: false,
      reason: "generation_failed",
      error: mErr.message,
    };
  }

  try {
    await refreshCampaignRollup(input.supabase, campaignId);
  } catch (rollupErr) {
    console.error("[generateAiCampaignDraft] refreshCampaignRollup:", rollupErr);
  }

  const { data: full } = await input.supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .single();

  return {
    ok: true,
    campaign: (full ?? campaign) as Record<string, unknown>,
    messagesCreated: messageRows.length,
    targetsConsidered: focusFiltered.length,
    generationReason: focusGenerationReason,
    emptyReason: null,
  };
}
