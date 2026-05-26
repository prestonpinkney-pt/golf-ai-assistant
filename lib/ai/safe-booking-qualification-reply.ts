import type { AiResponseDecision } from "@/lib/ai/conversation-reply-core";
import { DEFAULT_RISKY_INBOUND_TERMS } from "@/app/api/config/ai-source-of-truth";

/** Inbound substrings that block safe booking qualification routing. */
const SAFE_QUALIFICATION_BLOCKED_INBOUND = [
  ...DEFAULT_RISKY_INBOUND_TERMS,
  "membership",
  "charged",
  "charge me",
  "billing",
  "furious",
  "pissed",
] as const;

const CONFIRMATION_REPLY_TERMS = [
  "booked",
  "confirmed",
  "reserved",
  "locked in",
  "scheduled",
  "you're all set",
  "you are all set",
  "all set for",
  "see you at",
] as const;

const QUALIFYING_REPLY_PATTERNS: RegExp[] = [
  /how many\s+(players|people|guests)/i,
  /how many players/i,
  /practice\s+or\s+(a\s+)?round/i,
  /(practice|round).+\bor\b.+(practice|round)/i,
  /\b9\s+or\s+18\b/i,
  /(morning|afternoon|evening).*(prefer|work|thinking|\?)/i,
  /prefer\s+(morning|afternoon|evening)/i,
  /(what|which)\s+day/i,
  /day\s+works/i,
  /hourly\s+bay/i,
  /players\s+total/i,
];

/** Default low-risk follow-up when model over-escalates a safe availability ask. */
export const SAFE_AVAILABILITY_PLAYER_COUNT_REPLY =
  "Got it — how many players total?";

export type SafeBookingQualificationInput = {
  inboundText: string;
  replyText: string;
  intent: string;
  playbook: string;
  /** When true, never treat as safe qualification (Whoosh-confirmed booking path). */
  bookingConfirmedByWhoosh?: boolean;
};

function includesAnyTerm(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function isAvailabilityStyleInquiry(inboundText: string): boolean {
  const t = inboundText.toLowerCase();
  if (/\bavailable\b|\bavailability\b/.test(t)) return true;
  if (/\b(open|any)\b.*\b(slot|slots|time|times|bay)\b/.test(t)) return true;
  if (/\b(simulator|sim bay|bay time|trackman)\b/.test(t)) return true;
  if (/\b(this week|today|tomorrow|weekend|weekday)\b/.test(t) && /\b(time|times|slot|open|available)\b/.test(t)) {
    return true;
  }
  const weekdays =
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/;
  if (weekdays.test(t) && /\b(time|times|slot|available|open)\b/.test(t)) {
    return true;
  }
  return false;
}

function isBookingQualificationContext(input: {
  playbook: string;
  intent: string;
  inboundText: string;
}): boolean {
  const playbook = input.playbook.trim().toLowerCase();
  if (playbook === "simulator") return true;

  const intent = input.intent.trim().toLowerCase();
  if (intent.includes("availability") || intent.includes("booking")) {
    return true;
  }

  return isAvailabilityStyleInquiry(input.inboundText);
}

/** Customer is asking to confirm/hold a specific slot — not safe for auto-send without Whoosh. */
export function inboundRequestsExplicitBookingConfirmation(inboundText: string): boolean {
  const t = inboundText.toLowerCase();
  const wantsAction =
    /\b(confirm|book me|reserve me|hold me|lock me in|sign me up|put me down)\b/.test(
      t
    ) || /\bconfirm\s+me\b/.test(t);

  if (!wantsAction) return false;

  if (hasExplicitClockTime(inboundText)) return true;

  const weekdayWithTime =
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b.*\b(at|@)\s*\d{1,2}/i.test(
      inboundText
    ) || /\bfor\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+at\b/i.test(
      t
    );

  return weekdayWithTime;
}

export function hasExplicitClockTime(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b\d{1,2}:\d{2}\b/.test(t)) return true;
  if (/\b\d{1,2}\s*(am|pm|a\.m\.|p\.m\.)\b/i.test(text)) return true;
  if (/\b(at|@)\s*\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?\b/i.test(text)) return true;
  return false;
}

export function replyContainsExactUnverifiedTime(replyText: string): boolean {
  return hasExplicitClockTime(replyText);
}

export function replyContainsBookingConfirmationLanguage(replyText: string): boolean {
  return includesAnyTerm(replyText, CONFIRMATION_REPLY_TERMS);
}

export function replyAsksQualifyingQuestion(replyText: string): boolean {
  return QUALIFYING_REPLY_PATTERNS.some((pattern) => pattern.test(replyText));
}

/**
 * True when an availability/simulator inquiry received a low-stakes qualifying follow-up
 * (no exact times or booking confirmation language).
 */
export function isSafeBookingQualificationReply(
  input: SafeBookingQualificationInput
): boolean {
  if (input.bookingConfirmedByWhoosh) return false;

  const inbound = (input.inboundText || "").trim();
  const reply = (input.replyText || "").trim();
  if (!inbound || !reply) return false;

  if (includesAnyTerm(inbound, SAFE_QUALIFICATION_BLOCKED_INBOUND)) {
    return false;
  }

  if (inboundRequestsExplicitBookingConfirmation(inbound)) {
    return false;
  }

  if (!isBookingQualificationContext({
    playbook: input.playbook,
    intent: input.intent,
    inboundText: inbound,
  })) {
    return false;
  }

  if (!isAvailabilityStyleInquiry(inbound)) {
    return false;
  }

  if (replyContainsExactUnverifiedTime(reply)) return false;
  if (replyContainsBookingConfirmationLanguage(reply)) return false;
  if (!replyAsksQualifyingQuestion(reply)) return false;

  return true;
}

/** Downgrade model over-escalation for safe simulator/availability qualification replies. */
export function applySafeBookingQualificationNormalization(
  decision: AiResponseDecision,
  input: Omit<SafeBookingQualificationInput, "replyText"> & {
    replyText?: string;
  }
): AiResponseDecision {
  const inbound = (input.inboundText || "").trim();
  const replyText = (input.replyText ?? decision.reply_text).trim();

  const safeAvailabilityContext =
    inbound.length > 0 &&
    !includesAnyTerm(inbound, SAFE_QUALIFICATION_BLOCKED_INBOUND) &&
    !inboundRequestsExplicitBookingConfirmation(inbound) &&
    isBookingQualificationContext({
      playbook: input.playbook,
      intent: input.intent ?? decision.intent,
      inboundText: inbound,
    }) &&
    isAvailabilityStyleInquiry(inbound);

  let effectiveReply = replyText;
  if (
    safeAvailabilityContext &&
    !isSafeBookingQualificationReply({
      inboundText: inbound,
      replyText,
      intent: input.intent ?? decision.intent,
      playbook: input.playbook,
      bookingConfirmedByWhoosh: input.bookingConfirmedByWhoosh,
    }) &&
    !replyContainsExactUnverifiedTime(replyText) &&
    !replyContainsBookingConfirmationLanguage(replyText)
  ) {
    effectiveReply = SAFE_AVAILABILITY_PLAYER_COUNT_REPLY;
  }

  if (
    !isSafeBookingQualificationReply({
      inboundText: inbound,
      replyText: effectiveReply,
      intent: input.intent ?? decision.intent,
      playbook: input.playbook,
      bookingConfirmedByWhoosh: input.bookingConfirmedByWhoosh,
    })
  ) {
    return decision;
  }

  return {
    ...decision,
    reply_text: effectiveReply,
    risk_level: "low",
    escalation_required: false,
    escalation_reason: null,
    can_auto_send: true,
  };
}
