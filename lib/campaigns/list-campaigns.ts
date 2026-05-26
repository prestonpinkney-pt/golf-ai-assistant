import type { SupabaseClient } from "@supabase/supabase-js";
import {
  postgrestMissingColumn,
  postgrestMissingTable,
} from "@/lib/supabase-postgrest-errors";
import {
  buildCampaignsSetupMessage,
  diagnoseCampaignsPostgrestError,
  isDevelopmentRuntime,
  type CampaignsMissingPiece,
} from "./setup-diagnostics";

const CAMPAIGNS_SELECT_FULL =
  "id, business_id, name, campaign_type, playbook_key, status, source, total_recipients, total_drafted, total_approved, total_sent, total_failed, created_at, updated_at, approved_at, sent_at, metadata";

const CAMPAIGNS_SELECT_MINIMAL =
  "id, business_id, name, playbook_key, status, total_recipients, total_drafted, total_approved, total_sent, total_failed, created_at, updated_at";

export type ListCampaignsResult =
  | {
      ok: true;
      campaigns: unknown[];
      setupRequired: false;
    }
  | {
      ok: true;
      campaigns: [];
      setupRequired: true;
      setupMessage: string;
      missing: CampaignsMissingPiece[];
      debugError?: string;
    }
  | {
      ok: false;
      setupRequired: boolean;
      setupMessage: string;
      missing: CampaignsMissingPiece[];
      debugError?: string;
      message: string;
    };

export async function listCampaignsForBusiness(
  supabase: SupabaseClient,
  businessId: string
): Promise<ListCampaignsResult> {
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
    console.error("[campaigns] list query failed:", {
      select: sel,
      businessId,
      message: error.message,
      code: (error as { code?: string }).code,
    });

    const diagnosis = diagnoseCampaignsPostgrestError(error.message);
    if (diagnosis.setupRequired) {
      const setupMessage = buildCampaignsSetupMessage(diagnosis.missing);
      return {
        ok: true,
        campaigns: [],
        setupRequired: true,
        setupMessage,
        missing: diagnosis.missing,
        ...(isDevelopmentRuntime() ? { debugError: error.message } : {}),
      };
    }

    if (postgrestMissingColumn(error.message)) {
      continue;
    }

    return {
      ok: false,
      setupRequired: false,
      setupMessage: lastMsg,
      missing: [],
      message: lastMsg,
      ...(isDevelopmentRuntime() ? { debugError: error.message } : {}),
    };
  }

  const diagnosis = diagnoseCampaignsPostgrestError(lastMsg);
  const missing =
    diagnosis.missing.length > 0 ? diagnosis.missing : (["columns"] as CampaignsMissingPiece[]);
  const setupMessage = buildCampaignsSetupMessage(missing);

  if (postgrestMissingTable(lastMsg, "campaigns")) {
    return {
      ok: true,
      campaigns: [],
      setupRequired: true,
      setupMessage,
      missing,
      ...(isDevelopmentRuntime() ? { debugError: lastMsg } : {}),
    };
  }

  return {
    ok: false,
    setupRequired: true,
    setupMessage,
    missing,
    message: lastMsg || "Failed to load campaigns",
    ...(isDevelopmentRuntime() ? { debugError: lastMsg } : {}),
  };
}
