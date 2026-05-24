/**
 * CloseOS messaging policy — V1 (pure logic).
 *
 * Decides allowance, mode, escalation, suppression reasons, cadence boundaries,
 * and **copy constraints / guidance only**. It must **not** emit final customer-facing
 * SMS strings; wording stays in a separate messaging / language layer (e.g. AI prompts,
 * hand-authored templates elsewhere, deterministic draft builders).
 *
 * Product principle: aggressive opportunity detection · disciplined customer contact ·
 * natural human messaging — policy enforces discipline without dictating verbatim copy.
 */

export type MessagingPolicyModeV1 =
  | "allowed_auto_send"
  | "recommend_approval"
  | "suppress_due_to_policy"
  | "cooldown"
  | "escalate_to_human";

export type MessagingPolicyCtaStyleV1 =
  | "soft_direct"
  | "reply_to_book"
  | "offer_help"
  | "close_out";

export type MessagingPolicyFollowUpStageV1 =
  | "initial"
  | "light_nudge"
  | "final_nudge"
  | "cooldown";

export type MessagingPolicyCopyGuidanceV1 = {
  audience: "public" | "members";
  messageGoal: string;
  tone: "natural_primetime_front_desk";
  maxQuestions: number;
  avoidExactRepeat: boolean;
  avoidRecentAngles: boolean;
  forbiddenPhrases: readonly string[];
  suggestedCtaStyle: MessagingPolicyCtaStyleV1;
  followUpStage?: MessagingPolicyFollowUpStageV1;
};

export type MessagingPolicyDecisionV1 = {
  mode: MessagingPolicyModeV1;
  /**
   * Whether the journey may continue toward drafting (human or automated).
   * False when suppressed, cooling down for send, or escalated away from automation.
   */
  allowed: boolean;
  approvalRequired: boolean;
  /** Stable machine codes for routing, audit, and UI (not shown to customers). */
  reasonCodes: string[];
  /** Constraints for the language layer — never verbatim mandated SMS. */
  copyGuidance: MessagingPolicyCopyGuidanceV1;
  /** Operator/log hints; not customer copy. */
  notes?: string[];
};

export type MessagingPolicyInputV1 = {
  nowMs: number;
  opportunityAudience: "public" | "members";
  /** Recipient matches the campaign/opportunity audience (member vs public). */
  audienceEligible: boolean;

  optedOut: boolean;
  humanTakeover: boolean;
  automationDisabled: boolean;
  /** Complaints, legal, refunds, safety, or other high-stakes threads. */
  highStakesOrSensitive: boolean;

  /**
   * Cold leads must not receive unattended auto-sends; policy may still allow
   * draft + approval or operator-led sends outside this evaluator.
   */
  coldLead: boolean;

  lastOutboundAtMs: number | null;
  minHoursBetweenOutbound: number;
  outboundCount24h: number;
  maxOutboundPer24h: number;

  /** Nudges already sent for this angle / initiative. */
  nudgeCount: number;
  maxNudges: number;

  sameAngleRecentlySent: boolean;
  /** Related angles touched recently — language layer should vary (policy flags only). */
  hasRecentRelatedAngles: boolean;

  messageGoal: string;
  suggestedCtaStyle: MessagingPolicyCtaStyleV1;

  /** When true, `allowed_auto_send` is never returned even if otherwise eligible. */
  autoSendGloballyDisabled: boolean;
};

/** Default wording guardrails for Primetime SMS — complements config-driven lists elsewhere. */
export const DEFAULT_FORBIDDEN_PHRASES_PRIMETIME_V1 = [
  "synced schedule",
  "utilization",
  "based on our system",
  "our ai",
  "as an ai",
  "automated message",
] as const;

function hoursBetween(aMs: number, bMs: number): number {
  return Math.abs(bMs - aMs) / (1000 * 60 * 60);
}

/** Map nudge count to follow-up stage for copy guidance only (caller may clamp nudges separately). */
export function followUpStageFromNudgeCountV1(
  nudgeCount: number
): MessagingPolicyFollowUpStageV1 | undefined {
  if (nudgeCount <= 0) return "initial";
  if (nudgeCount === 1) return "light_nudge";
  if (nudgeCount === 2) return "final_nudge";
  return "cooldown";
}

function buildCopyGuidance(
  input: Pick<
    MessagingPolicyInputV1,
    | "opportunityAudience"
    | "messageGoal"
    | "suggestedCtaStyle"
    | "sameAngleRecentlySent"
    | "hasRecentRelatedAngles"
    | "nudgeCount"
  >
): MessagingPolicyCopyGuidanceV1 {
  const avoidRecentAngles =
    input.sameAngleRecentlySent || input.hasRecentRelatedAngles;
  return {
    audience: input.opportunityAudience,
    messageGoal: input.messageGoal,
    tone: "natural_primetime_front_desk",
    maxQuestions: 1,
    avoidExactRepeat: true,
    avoidRecentAngles,
    forbiddenPhrases: [...DEFAULT_FORBIDDEN_PHRASES_PRIMETIME_V1],
    suggestedCtaStyle: input.suggestedCtaStyle,
    followUpStage: followUpStageFromNudgeCountV1(input.nudgeCount),
  };
}

/**
 * Evaluate messaging policy — **constraints only**, no final SMS body.
 *
 * Precedence is strict first match on hard blocks (opt-out → human/automation stops →
 * risk → eligibility → repetition → caps → cooldown → warmth/auto rules).
 */
export function evaluateMessagingPolicyV1(
  input: MessagingPolicyInputV1
): MessagingPolicyDecisionV1 {
  const guidance = buildCopyGuidance(input);

  const base = (
    overrides: Omit<
      Partial<MessagingPolicyDecisionV1>,
      "copyGuidance" | "reasonCodes"
    > & {
      reasonCodes?: string[];
    }
  ): MessagingPolicyDecisionV1 => ({
    mode: overrides.mode ?? "suppress_due_to_policy",
    allowed: overrides.allowed ?? false,
    approvalRequired: overrides.approvalRequired ?? false,
    reasonCodes: overrides.reasonCodes ?? [],
    copyGuidance: guidance,
    notes: overrides.notes,
  });

  if (input.optedOut) {
    return base({
      mode: "suppress_due_to_policy",
      allowed: false,
      approvalRequired: false,
      reasonCodes: ["opt_out"],
      notes: ["Do not send; respect opt-out."],
    });
  }

  if (input.humanTakeover) {
    return base({
      mode: "escalate_to_human",
      allowed: false,
      approvalRequired: false,
      reasonCodes: ["human_takeover"],
      notes: ["Automation halted — human owns the thread."],
    });
  }

  if (input.automationDisabled) {
    return base({
      mode: "escalate_to_human",
      allowed: false,
      approvalRequired: false,
      reasonCodes: ["automation_disabled"],
      notes: ["Automation disabled on conversation."],
    });
  }

  if (input.highStakesOrSensitive) {
    return base({
      mode: "escalate_to_human",
      allowed: false,
      approvalRequired: false,
      reasonCodes: ["high_stakes_or_sensitive"],
      notes: ["Escalate — complaints, refunds, legal, safety, or similar."],
    });
  }

  if (!input.audienceEligible) {
    return base({
      mode: "suppress_due_to_policy",
      allowed: false,
      approvalRequired: false,
      reasonCodes: ["audience_mismatch"],
      notes: ["Recipient not eligible for this opportunity audience."],
    });
  }

  if (input.sameAngleRecentlySent) {
    return base({
      mode: "suppress_due_to_policy",
      allowed: false,
      approvalRequired: false,
      reasonCodes: ["same_angle_recent"],
      notes: ["Avoid repetitive angle — language layer must not rerun same pitch."],
    });
  }

  if (input.outboundCount24h >= input.maxOutboundPer24h) {
    return base({
      mode: "suppress_due_to_policy",
      allowed: false,
      approvalRequired: false,
      reasonCodes: ["frequency_cap_24h"],
      notes: ["24h outbound cap reached for this recipient."],
    });
  }

  if (input.nudgeCount >= input.maxNudges) {
    return base({
      mode: "suppress_due_to_policy",
      allowed: false,
      approvalRequired: false,
      reasonCodes: ["nudge_cap"],
      notes: ["Max nudges for this initiative reached."],
    });
  }

  if (
    input.lastOutboundAtMs != null &&
    hoursBetween(input.lastOutboundAtMs, input.nowMs) <
      input.minHoursBetweenOutbound
  ) {
    return base({
      mode: "cooldown",
      allowed: false,
      approvalRequired: false,
      reasonCodes: ["cooldown_active"],
      notes: [
        `Minimum ${input.minHoursBetweenOutbound}h between outbounds — not elapsed.`,
      ],
    });
  }

  const reasons: string[] = ["eligible"];

  if (input.coldLead) {
    reasons.push("cold_lead_guard");
    return base({
      mode: "recommend_approval",
      allowed: true,
      approvalRequired: true,
      reasonCodes: reasons,
      notes: ["Warm paths may auto later; cold leads require human approval before send."],
    });
  }

  if (input.autoSendGloballyDisabled) {
    return base({
      mode: "recommend_approval",
      allowed: true,
      approvalRequired: true,
      reasonCodes: [...reasons, "auto_send_disabled_global"],
      notes: ["Global auto-send off — draft allowed, approval expected."],
    });
  }

  return base({
    mode: "allowed_auto_send",
    allowed: true,
    approvalRequired: false,
    reasonCodes: [...reasons, "policy_auto_send_ok"],
    notes: ["Automation may compose/send only when wired — language layer stays separate."],
  });
}
