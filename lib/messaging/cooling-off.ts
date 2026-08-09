/** Default cooling-off window after uninterested language (matches legacy /api/inbound). */
export const COOLING_OFF_DAYS = 14;

/**
 * Clear decline phrases — safe to match as substrings inside longer messages
 * (e.g. "Thanks but not interested right now").
 */
export const CLEAR_UNINTERESTED_PHRASES = [
  "not interested",
  "not right now",
  "i’ll let you know",
  "i'll let you know",
] as const;

/**
 * Short / ambiguous phrases that commonly appear inside affirmative booking
 * language ("I'm good with Saturday", "just looking for lesson times").
 * These must match as the whole message (after light padding), not as substrings.
 */
export const STANDALONE_UNINTERESTED_PHRASES = [
  "maybe later",
  "i'm good",
  "im good",
  "just looking",
] as const;

export const UNINTERESTED_PHRASES = [
  ...CLEAR_UNINTERESTED_PHRASES,
  ...STANDALONE_UNINTERESTED_PHRASES,
] as const;

/** Strip leading thanks/ok/no filler and trailing punctuation for standalone matching. */
function normalizeUninterestedCore(normalized: string): string {
  let core = normalized.replace(/[!.?,…]+$/g, "").trim();
  // Allow a couple of polite/filler prefixes: "Thanks, I'm good", "No thanks I'm good".
  for (let i = 0; i < 2; i += 1) {
    const stripped = core.replace(
      /^(thanks|thank you|thx|ok|okay|nah|nope|no)[,!.\s]+/i,
      ""
    );
    if (stripped === core) break;
    core = stripped.trim();
  }
  return core;
}

export function isUninterestedMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  if (CLEAR_UNINTERESTED_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return true;
  }

  const core = normalizeUninterestedCore(normalized);
  return STANDALONE_UNINTERESTED_PHRASES.some((phrase) => core === phrase);
}

export function computeCoolingOffUntil(
  from: Date = new Date(),
  days = COOLING_OFF_DAYS
): Date {
  const until = new Date(from);
  until.setDate(until.getDate() + days);
  return until;
}

export function isContactInCoolingOff(
  contact: { cooling_off_until?: string | null },
  now: Date = new Date()
): boolean {
  const raw = contact.cooling_off_until;
  if (!raw || typeof raw !== "string") return false;
  const until = Date.parse(raw);
  return !Number.isNaN(until) && until > now.getTime();
}

/** Mirrors operator send / AI draft API guards for tests and UI. */
export function getContactSendBlockedReason(contact: {
  sms_opt_out?: boolean | null;
  cooling_off_until?: string | null;
}): string | null {
  if (contact.sms_opt_out) {
    return "Contact has opted out of SMS; sending is blocked.";
  }
  if (isContactInCoolingOff(contact)) {
    return "Contact is in a cooling-off period; sending is temporarily blocked.";
  }
  return null;
}

export type ApplyContactCoolingOffInput = {
  contactId: string;
  messageText: string;
  conversationId?: string | null;
  inboundEventId?: string | null;
  now?: Date;
};

export type ApplyContactCoolingOffResult = {
  coolingOffUntil: string;
  coolingOffReason: string;
};
