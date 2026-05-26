import {
  postgrestMissingBusinessIdColumn,
  postgrestMissingColumn,
  postgrestMissingTable,
} from "@/lib/supabase-postgrest-errors";
import { CAMPAIGNS_SETUP_MESSAGE } from "@/app/api/campaigns/setup-copy";

export type CampaignsMissingPiece = "campaigns" | "campaign_messages" | "columns";

export function diagnoseCampaignsPostgrestError(message: string): {
  setupRequired: boolean;
  missing: CampaignsMissingPiece[];
} {
  const missing: CampaignsMissingPiece[] = [];

  if (postgrestMissingTable(message, "campaigns")) {
    missing.push("campaigns");
  }
  if (postgrestMissingTable(message, "campaign_messages")) {
    missing.push("campaign_messages");
  }
  if (
    postgrestMissingColumn(message) ||
    postgrestMissingBusinessIdColumn(message)
  ) {
    if (!missing.includes("columns")) {
      missing.push("columns");
    }
  }

  return {
    setupRequired: missing.length > 0,
    missing,
  };
}

export function buildCampaignsSetupMessage(missing: CampaignsMissingPiece[]): string {
  if (missing.includes("campaigns") || missing.includes("campaign_messages")) {
    return (
      "Campaign storage is not installed. Apply migration " +
      "supabase/migrations/20260508163000_campaigns_ledger.sql via the Supabase CLI " +
      "(supabase db push or supabase migration up)."
    );
  }
  if (missing.includes("columns")) {
    return (
      "Campaign storage schema is out of date. Apply the latest campaigns migration " +
      "via the Supabase CLI (supabase db push or supabase migration up)."
    );
  }
  return CAMPAIGNS_SETUP_MESSAGE;
}

export function isDevelopmentRuntime(): boolean {
  return process.env.NODE_ENV === "development";
}
