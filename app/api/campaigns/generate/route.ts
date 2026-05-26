import { ApiAuthError, requireBusinessUser } from "@/app/api/lib/require-auth";
import { generateAiCampaignDraft } from "@/lib/campaigns/generate-campaign";
import { isDevelopmentRuntime } from "@/lib/campaigns/setup-diagnostics";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { jsonNoStore } from "../_http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: Request) {
  let userId: string;
  let businessId: string;
  try {
    const ctx = await requireBusinessUser();
    userId = ctx.user.id;
    businessId = ctx.businessId;
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return jsonNoStore(
        { ok: false, error: "auth_failed", message: e.message },
        { status: e.statusCode }
      );
    }
    throw e;
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const payload = (body ?? {}) as {
    maxTargets?: unknown;
    playbookKey?: unknown;
    campaignFocus?: unknown;
  };

  const maxTargets =
    typeof payload.maxTargets === "number" && payload.maxTargets > 0
      ? Math.min(payload.maxTargets, 100)
      : undefined;

  const playbookKey =
    typeof payload.playbookKey === "string" && payload.playbookKey.trim()
      ? payload.playbookKey.trim()
      : undefined;

  const campaignFocusRaw =
    typeof payload.campaignFocus === "string" ? payload.campaignFocus.trim() : "";
  const campaignFocus =
    campaignFocusRaw === "simulator" ||
    campaignFocusRaw === "slow_time" ||
    campaignFocusRaw === "lessons" ||
    campaignFocusRaw === "memberships" ||
    campaignFocusRaw === "events"
      ? campaignFocusRaw
      : "best";

  const supabase = createSupabaseServiceRoleClient();

  const result = await generateAiCampaignDraft({
    supabase,
    businessId,
    userId,
    maxTargets,
    playbookKey,
    campaignFocus,
  });

  if (!result.ok) {
    if (result.reason === "whoosh_availability_required") {
      return jsonNoStore(
        {
          ok: false,
          error: "whoosh_availability_required",
          errorCode: "whoosh_availability_required",
          message:
            result.message ??
            "Whoosh availability is required before generating slow-time campaigns.",
        },
        { status: 422 }
      );
    }

    if (result.reason === "no_targets") {
      return jsonNoStore(
        {
          ok: false,
          error: "no_targets",
          emptyReason: result.emptyReason,
          message: result.emptyReason,
        },
        { status: 404 }
      );
    }

    if (result.reason === "setup_required" || result.reason === "migration_missing") {
      return jsonNoStore(
        {
          ok: false,
          error: result.reason === "migration_missing" ? "migration_missing" : "setup_required",
          setupRequired: true,
          setupMessage: result.setupMessage,
          missing: result.missing,
          message: result.setupMessage,
          ...(isDevelopmentRuntime() && result.error ? { debugError: result.error } : {}),
        },
        { status: 503 }
      );
    }

    return jsonNoStore(
      {
        ok: false,
        error: "generation_failed",
        message: result.error ?? "Campaign generation failed",
        ...(isDevelopmentRuntime() && result.error ? { debugError: result.error } : {}),
      },
      { status: 500 }
    );
  }

  const campaignId =
    typeof result.campaign.id === "string" ? result.campaign.id : null;

  return jsonNoStore({
    ok: true,
    campaign: result.campaign,
    campaign_id: campaignId,
    messagesCreated: result.messagesCreated,
    targetsConsidered: result.targetsConsidered,
    generationReason: result.generationReason,
  });
}
