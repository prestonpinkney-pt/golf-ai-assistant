import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateMessagingPolicyV1,
  type MessagingPolicyDecisionV1,
} from "@/lib/messaging-policy";
import { isInboundQuietHoursActive } from "@/lib/messaging/quiet-hours";
import { normalizePhone } from "@/lib/messaging/phone";

const DEFAULT_MIN_HOURS_BETWEEN = 24;
const DEFAULT_MAX_OUTBOUND_24H = 3;
const DEFAULT_MAX_NUDGES = 3;

export function parseTestSmsAllowlist(): Set<string> {
  const raw = process.env.CLOSEOS_TEST_SMS_ALLOWLIST?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export function isLikelyE164Phone(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value.trim());
}

export type CampaignSendBlockReason =
  | "quiet_hours"
  | "test_allowlist"
  | "policy_opt_out"
  | "policy_cooldown"
  | "policy_frequency_cap"
  | "policy_suppressed";

export type CampaignSendEligibility = {
  allowed: boolean;
  reason: CampaignSendBlockReason | null;
  detail: string;
  policyReasonCodes: string[];
};

export function evaluateCampaignSendWindow(): CampaignSendEligibility {
  if (isInboundQuietHoursActive()) {
    return {
      allowed: false,
      reason: "quiet_hours",
      detail: "Quiet hours are active — defer campaign send until the window opens.",
      policyReasonCodes: ["quiet_hours"],
    };
  }
  return {
    allowed: true,
    reason: null,
    detail: "",
    policyReasonCodes: [],
  };
}

export function evaluateCampaignTestAllowlist(toPhone: string): CampaignSendEligibility {
  const allow = parseTestSmsAllowlist();
  if (allow.size === 0) {
    return {
      allowed: true,
      reason: null,
      detail: "",
      policyReasonCodes: [],
    };
  }
  const normalized = normalizePhone(toPhone) ?? toPhone.trim();
  if (allow.has(normalized)) {
    return {
      allowed: true,
      reason: null,
      detail: "",
      policyReasonCodes: ["test_allowlist_ok"],
    };
  }
  return {
    allowed: false,
    reason: "test_allowlist",
    detail:
      "Recipient not in CLOSEOS_TEST_SMS_ALLOWLIST — add this E.164 or clear the env before bulk send.",
    policyReasonCodes: ["test_allowlist_blocked"],
  };
}

async function loadRecipientOutboundStats(
  supabase: SupabaseClient,
  contactId: string | null,
  phone: string
): Promise<{ lastOutboundAtMs: number | null; outboundCount24h: number }> {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let q = supabase
    .from("messages")
    .select("created_at, sent_at")
    .eq("direction", "outbound")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(50);

  if (contactId) {
    q = q.eq("contact_id", contactId);
  } else {
    q = q.eq("contact_phone", phone);
  }

  const { data, error } = await q;
  if (error) {
    console.warn("[campaign-send-eligibility] outbound stats:", error.message);
    return { lastOutboundAtMs: null, outboundCount24h: 0 };
  }

  const rows = data ?? [];
  let lastOutboundAtMs: number | null = null;
  for (const row of rows) {
    const iso =
      (typeof row.sent_at === "string" && row.sent_at) ||
      (typeof row.created_at === "string" && row.created_at) ||
      null;
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    if (lastOutboundAtMs == null || ms > lastOutboundAtMs) {
      lastOutboundAtMs = ms;
    }
  }

  return { lastOutboundAtMs, outboundCount24h: rows.length };
}

export async function evaluateCampaignRecipientPolicy(
  supabase: SupabaseClient,
  input: {
    contactId: string | null;
    phone: string;
    smsOptOut: boolean;
    humanTakeover?: boolean;
    automationDisabled?: boolean;
  }
): Promise<CampaignSendEligibility> {
  if (input.smsOptOut) {
    return {
      allowed: false,
      reason: "policy_opt_out",
      detail: "Contact opted out of SMS",
      policyReasonCodes: ["opt_out"],
    };
  }

  const stats = await loadRecipientOutboundStats(
    supabase,
    input.contactId,
    input.phone
  );

  const decision = evaluateMessagingPolicyV1({
    nowMs: Date.now(),
    opportunityAudience: "public",
    audienceEligible: true,
    optedOut: false,
    humanTakeover: Boolean(input.humanTakeover),
    automationDisabled: Boolean(input.automationDisabled),
    highStakesOrSensitive: false,
    coldLead: false,
    lastOutboundAtMs: stats.lastOutboundAtMs,
    minHoursBetweenOutbound: DEFAULT_MIN_HOURS_BETWEEN,
    outboundCount24h: stats.outboundCount24h,
    maxOutboundPer24h: DEFAULT_MAX_OUTBOUND_24H,
    nudgeCount: 0,
    maxNudges: DEFAULT_MAX_NUDGES,
    sameAngleRecentlySent: false,
    hasRecentRelatedAngles: false,
    messageGoal: "campaign_outbound",
    suggestedCtaStyle: "soft_direct",
    autoSendGloballyDisabled: true,
  });

  if (decision.allowed) {
    return {
      allowed: true,
      reason: null,
      detail: "",
      policyReasonCodes: decision.reasonCodes,
    };
  }

  const codes = decision.reasonCodes;
  let reason: CampaignSendBlockReason = "policy_suppressed";
  let detail = decision.notes?.[0] ?? "Send blocked by messaging policy";

  if (codes.includes("cooldown_active")) {
    reason = "policy_cooldown";
    detail = "Minimum cooldown between outbound messages has not elapsed.";
  } else if (codes.includes("frequency_cap_24h")) {
    reason = "policy_frequency_cap";
    detail = "24h outbound cap reached for this recipient.";
  }

  return {
    allowed: false,
    reason,
    detail,
    policyReasonCodes: codes,
  };
}

export type LiveOutboundPolicyResult = {
  /** True only when unattended provider send is permitted (auto-send path). */
  maySendViaProvider: boolean;
  decision: MessagingPolicyDecisionV1;
  blockDetail: string | null;
};

export function evaluateLiveOutboundPolicy(input: {
  smsOptOut: boolean;
  humanTakeover: boolean;
  automationDisabled: boolean;
  highStakesOrSensitive: boolean;
  autoSendEnabled: boolean;
  messageGoal: string;
  lastOutboundAtMs: number | null;
  outboundCount24h: number;
}): LiveOutboundPolicyResult {
  const decision = evaluateMessagingPolicyV1({
    nowMs: Date.now(),
    opportunityAudience: "public",
    audienceEligible: true,
    optedOut: input.smsOptOut,
    humanTakeover: input.humanTakeover,
    automationDisabled: input.automationDisabled,
    highStakesOrSensitive: input.highStakesOrSensitive,
    coldLead: false,
    lastOutboundAtMs: input.lastOutboundAtMs,
    minHoursBetweenOutbound: DEFAULT_MIN_HOURS_BETWEEN,
    outboundCount24h: input.outboundCount24h,
    maxOutboundPer24h: DEFAULT_MAX_OUTBOUND_24H,
    nudgeCount: 0,
    maxNudges: DEFAULT_MAX_NUDGES,
    sameAngleRecentlySent: false,
    hasRecentRelatedAngles: false,
    messageGoal: input.messageGoal,
    suggestedCtaStyle: "soft_direct",
    autoSendGloballyDisabled: !input.autoSendEnabled,
  });

  const maySendViaProvider =
    decision.allowed &&
    !decision.approvalRequired &&
    decision.mode === "allowed_auto_send";

  return {
    maySendViaProvider,
    decision,
    blockDetail: maySendViaProvider
      ? null
      : decision.notes?.[0] ?? "Send blocked by messaging policy",
  };
}

export async function evaluateInboundLiveOutboundPolicy(
  supabase: SupabaseClient,
  input: {
    contactId: string;
    phone: string;
    smsOptOut: boolean;
    humanTakeover: boolean;
    automationDisabled: boolean;
    highStakesOrSensitive: boolean;
    autoSendEnabled: boolean;
    messageGoal: string;
  }
): Promise<LiveOutboundPolicyResult> {
  const stats = await loadRecipientOutboundStats(
    supabase,
    input.contactId,
    input.phone
  );

  return evaluateLiveOutboundPolicy({
    smsOptOut: input.smsOptOut,
    humanTakeover: input.humanTakeover,
    automationDisabled: input.automationDisabled,
    highStakesOrSensitive: input.highStakesOrSensitive,
    autoSendEnabled: input.autoSendEnabled,
    messageGoal: input.messageGoal,
    lastOutboundAtMs: stats.lastOutboundAtMs,
    outboundCount24h: stats.outboundCount24h,
  });
}
