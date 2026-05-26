import { CAMPAIGNS_SETUP_MESSAGE } from "@/app/api/campaigns/setup-copy";
import type { CampaignsMissingPiece } from "./setup-diagnostics";

export type CampaignRow = {
  id: string;
  name: string;
  status: string;
  total_recipients: number;
  total_drafted: number;
  total_approved: number;
  total_sent: number;
  total_failed: number;
  created_at: string;
  updated_at: string;
};

export type CampaignsListApiPayload = {
  campaigns?: CampaignRow[];
  setupRequired?: boolean;
  setupMessage?: string;
  missing?: CampaignsMissingPiece[];
  error?: string;
  debugError?: string;
};

export type CampaignsListUiState = {
  campaigns: CampaignRow[];
  error: string | null;
  setupMessage: string | null;
  missing: CampaignsMissingPiece[];
  debugError: string | null;
};

export function resolveCampaignsListUiState(
  resOk: boolean,
  json: CampaignsListApiPayload
): CampaignsListUiState {
  const empty: CampaignsListUiState = {
    campaigns: [],
    error: null,
    setupMessage: null,
    missing: [],
    debugError: null,
  };

  if (json.setupRequired) {
    return {
      ...empty,
      setupMessage: json.setupMessage ?? CAMPAIGNS_SETUP_MESSAGE,
      missing: Array.isArray(json.missing) ? json.missing : [],
      debugError: json.debugError ?? null,
    };
  }

  if (!resOk) {
    const base = json.setupMessage ?? json.error ?? "Failed to load campaigns";
    return {
      ...empty,
      error: base,
      setupMessage: json.setupMessage ?? null,
      missing: Array.isArray(json.missing) ? json.missing : [],
      debugError: json.debugError ?? null,
    };
  }

  return {
    campaigns: Array.isArray(json.campaigns) ? json.campaigns : [],
    error: null,
    setupMessage: null,
    missing: [],
    debugError: null,
  };
}

export function formatCampaignsSetupBanner(state: CampaignsListUiState): string {
  if (!state.setupMessage) return "";
  if (state.missing.length === 0) return state.setupMessage;
  return `${state.setupMessage} (missing: ${state.missing.join(", ")})`;
}

export function formatCampaignsErrorBanner(state: CampaignsListUiState): string {
  if (!state.error) return "";
  if (state.debugError && process.env.NODE_ENV === "development") {
    return `${state.error} — ${state.debugError}`;
  }
  return state.error;
}
