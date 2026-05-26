/** Default cooling-off window after uninterested language (matches legacy /api/inbound). */
export const COOLING_OFF_DAYS = 14;

export const UNINTERESTED_PHRASES = [
  "not interested",
  "maybe later",
  "i'm good",
  "im good",
  "i’ll let you know",
  "i'll let you know",
  "not right now",
  "just looking",
] as const;

export function isUninterestedMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return UNINTERESTED_PHRASES.some((phrase) => normalized.includes(phrase));
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
