import type { SupabaseClient } from "@supabase/supabase-js";

import {
  evaluateInboundLiveOutboundPolicy,
  isLikelyE164Phone,
  parseTestSmsAllowlist,
} from "@/lib/campaigns/send-eligibility";
import { isContactInCoolingOff } from "@/lib/messaging/cooling-off";
import { isInboundQuietHoursActive } from "@/lib/messaging/quiet-hours";
import {
  resolveSentDmApiKey,
  resolveSentDmSendMode,
} from "@/lib/sentdm/send-message";
import { normalizePhone } from "@/lib/messaging/phone";

/** Exact blocker codes surfaced in QA and audit metadata. */
export type InboundProviderSendBlocker =
  | "auto_send_disabled"
  | "human_takeover"
  | "automation_disabled"
  | "quiet_hours"
  | "sms_opt_out"
  | "cooling_off"
  | "high_stakes_or_sensitive"
  | "not_allowlisted"
  | "missing_sentdm_api_key"
  | "missing_template_id"
  | "sentdm_api_error"
  | "invalid_phone"
  | "model_should_send_false"
  | "defer_outbound_sms"
  | "policy_frequency_cap"
  | "policy_cooldown";

export function isLiveAgentTestMode(): boolean {
  return (
    process.env.CLOSEOS_LIVE_AGENT_TEST_MODE?.trim().toLowerCase() === "true"
  );
}

export function normalizeLiveAgentPhone(
  phone: string | null | undefined
): string | null {
  if (!phone || typeof phone !== "string") return null;
  const trimmed = phone.trim();
  return normalizePhone(trimmed) ?? trimmed;
}

export function isPhoneOnLiveAgentAllowlist(
  phone: string | null | undefined
): boolean {
  const normalized = normalizeLiveAgentPhone(phone);
  if (!normalized) return false;
  const allow = parseTestSmsAllowlist();
  if (allow.size === 0) return false;
  return allow.has(normalized);
}

export function liveAgentAllowlistRequired(): boolean {
  return isLiveAgentTestMode() && parseTestSmsAllowlist().size > 0;
}

export function validateSentDmOutboundPrerequisites(): InboundProviderSendBlocker | null {
  if (!resolveSentDmApiKey()) {
    return "missing_sentdm_api_key";
  }
  if (resolveSentDmSendMode() === "template") {
    const tid =
      process.env.SENT_DM_TEMPLATE_ID?.trim() ||
      process.env.SENTDM_TEMPLATE_ID?.trim() ||
      "";
    if (!tid) {
      return "missing_template_id";
    }
  }
  return null;
}

export type InboundProviderSendInput = {
  phone: string;
  contact: Record<string, unknown>;
  conversation: Record<string, unknown>;
  autoSendEnabled: boolean;
  modelShouldSend: boolean;
  deferOutboundSms: boolean;
  escalationHuman: boolean;
  riskLevel: string;
  shouldEscalate: boolean;
};

export type InboundProviderSendDecision = {
  allowProviderSend: boolean;
  blocker: InboundProviderSendBlocker | null;
  blockerDetail: string | null;
  allowlistPassed: boolean | null;
  quietHoursActive: boolean;
  liveAgentTestMode: boolean;
  policyReasonCodes: string[];
};

export function resolveInboundProviderSendBlocker(
  input: InboundProviderSendInput & {
    maySendViaProvider: boolean;
    policyReasonCodes: string[];
  }
): InboundProviderSendBlocker | null {
  if (input.contact.sms_opt_out === true) {
    return "sms_opt_out";
  }
  if (isContactInCoolingOff(input.contact)) {
    return "cooling_off";
  }
  if (input.conversation.human_takeover === true) {
    return "human_takeover";
  }
  if (input.conversation.automation_enabled === false) {
    return "automation_disabled";
  }
  if (
    input.escalationHuman ||
    input.shouldEscalate ||
    input.riskLevel === "high"
  ) {
    return "high_stakes_or_sensitive";
  }
  if (liveAgentAllowlistRequired() && !isPhoneOnLiveAgentAllowlist(input.phone)) {
    return "not_allowlisted";
  }
  if (!input.autoSendEnabled) {
    return "auto_send_disabled";
  }
  if (!input.modelShouldSend) {
    return "model_should_send_false";
  }
  if (!isLikelyE164Phone(input.phone)) {
    return "invalid_phone";
  }
  if (input.deferOutboundSms) {
    return "defer_outbound_sms";
  }
  if (isInboundQuietHoursActive()) {
    return "quiet_hours";
  }
  const prereq = validateSentDmOutboundPrerequisites();
  if (prereq) {
    return prereq;
  }
  if (!input.maySendViaProvider) {
    const codes = input.policyReasonCodes;
    if (codes.includes("frequency_cap_24h")) {
      return "policy_frequency_cap";
    }
    if (codes.includes("cooldown_active")) {
      return "policy_cooldown";
    }
    if (codes.includes("opt_out")) {
      return "sms_opt_out";
    }
    if (codes.includes("human_takeover")) {
      return "human_takeover";
    }
    if (codes.includes("automation_disabled")) {
      return "automation_disabled";
    }
    if (codes.includes("high_stakes_or_sensitive")) {
      return "high_stakes_or_sensitive";
    }
    return "policy_cooldown";
  }
  return null;
}

export async function computeInboundProviderSendDecision(
  supabase: SupabaseClient,
  input: InboundProviderSendInput
): Promise<InboundProviderSendDecision> {
  const quietHoursActive = isInboundQuietHoursActive();
  const liveAgentTestMode = isLiveAgentTestMode();
  const allowlistPassed =
    liveAgentAllowlistRequired() ?
      isPhoneOnLiveAgentAllowlist(input.phone)
    : null;

  const relaxFrequencyForLiveAgent =
    liveAgentTestMode && isPhoneOnLiveAgentAllowlist(input.phone);

  const liveOutboundPolicy = await evaluateInboundLiveOutboundPolicy(
    supabase,
    {
      contactId: String(input.contact.id ?? ""),
      phone: input.phone,
      smsOptOut: Boolean(input.contact.sms_opt_out),
      contactCoolingOff: isContactInCoolingOff(input.contact),
      humanTakeover: Boolean(input.conversation.human_takeover),
      automationDisabled: input.conversation.automation_enabled === false,
      highStakesOrSensitive:
        input.escalationHuman ||
        input.riskLevel === "high" ||
        input.shouldEscalate,
      autoSendEnabled: input.autoSendEnabled,
      messageGoal: "inbound_reply",
      relaxFrequencyLimits: relaxFrequencyForLiveAgent,
    }
  );

  const blocker = resolveInboundProviderSendBlocker({
    ...input,
    maySendViaProvider: liveOutboundPolicy.maySendViaProvider,
    policyReasonCodes: liveOutboundPolicy.decision.reasonCodes,
  });

  return {
    allowProviderSend: blocker === null,
    blocker,
    blockerDetail:
      blocker === null ?
        null
      : liveOutboundPolicy.blockDetail ??
        `Outbound blocked: ${blocker}`,
    allowlistPassed,
    quietHoursActive,
    liveAgentTestMode,
    policyReasonCodes: liveOutboundPolicy.decision.reasonCodes,
  };
}

/** Clears QA blockers on allowlisted contacts only (live agent test mode). */
export async function prepareAllowlistedContactForLiveAgentTest(
  supabase: SupabaseClient,
  phone: string
): Promise<{ contactId: string | null; conversationIds: string[] }> {
  if (!isLiveAgentTestMode()) {
    throw new Error(
      "prepareAllowlistedContactForLiveAgentTest requires CLOSEOS_LIVE_AGENT_TEST_MODE=true"
    );
  }
  if (!isPhoneOnLiveAgentAllowlist(phone)) {
    throw new Error(
      `${phone} is not on CLOSEOS_TEST_SMS_ALLOWLIST — refusing to mutate contact state`
    );
  }

  const normalized = normalizeLiveAgentPhone(phone);
  const lookupPhone = normalized ?? phone.trim();

  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("phone", lookupPhone)
    .maybeSingle();

  if (!contact?.id) {
    return { contactId: null, conversationIds: [] };
  }

  await supabase
    .from("contacts")
    .update({
      sms_opt_out: false,
      sms_opt_out_at: null,
      sms_opt_out_reason: null,
      cooling_off_until: null,
    })
    .eq("id", contact.id);

  const { data: conversations } = await supabase
    .from("conversations")
    .select("id")
    .eq("contact_id", contact.id);

  const conversationIds = (conversations ?? []).map((c) => String(c.id));

  if (conversationIds.length > 0) {
    await supabase
      .from("conversations")
      .update({
        automation_enabled: true,
        human_takeover: false,
        needs_human: false,
        escalation_reason: null,
        human_reason: null,
      })
      .in("id", conversationIds);
  }

  return { contactId: String(contact.id), conversationIds };
}
