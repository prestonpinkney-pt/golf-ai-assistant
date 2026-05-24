/**
 * Blocks outbound SMS that sound like Whoosh confirmations unless verified by gateway metadata.
 */

export const BOOKING_CONFIRMATION_HANDOFF_REPLY =
  "I have the details. I'll have the team confirm the booking for you shortly.";

export const WHOOSH_BOOKING_TROUBLE_HANDOFF_REPLY =
  "I have the details. I'm having trouble completing the live booking right now, so I'll have the team confirm it for you.";

/** Curly/smart apostrophe (iOS keyboards) vs ASCII `'` — both count for contractions like I’ll */
const A = "(?:'|\u2019)";

type PatternRule = {
  /** Metadata `confirmation_guard.triggered_pattern` */
  id: string;
  test: (body: string) => boolean;
};

function lookingForwardSeeingYouThenBookingContext(body: string): boolean {
  if (!/\blooking\s+forward\s+to\s+seeing\s+you\s+then\b/i.test(body)) return false;

  /** Require substantive booking wording (not “thanks, see you!” sign-offs alone). */
  return (
    /\b(bookings?|your\s+bay|\bbay\b|bay\s+time|sim\b|simulator|lesson|\d+\s+players?\b|\bplayers?\b|reserved|scheduled|appointment|checkout|slot|tee\s*time)\b/i.test(
      body
    ) || /\byour\s+booking\b/i.test(body)
  );
}

/** Order matters: narrower “I’ll lock/finalize/…” checks before generic `I’ll book`. */
const BOOKING_CONFIRMATION_RULES: PatternRule[] = [
  { id: "phrase_lock_it_in", test: (b) => /\block\s+it\s+in\b/i.test(b) },
  { id: "phrase_locked_in", test: (b) => /\blocked\s+in\b/i.test(b) },
  { id: "phrase_booking_is_locked", test: (b) => /\bbooking\s+is\s+locked\b/i.test(b) },
  {
    id: "phrase_your_booking_near_locked_in",
    test: (b) => /\byour\s+booking\b[\s\S]{0,220}?\blocked\s+in\b/i.test(b),
  },
  {
    id: "phrase_ll_finalize",
    test: (b) => new RegExp(`\\bi${A}ll\\s+finalize\\b`, "i").test(b),
  },
  {
    id: "phrase_finalize_your_booking",
    test: (b) => /\bfinalize\s+your\s+booking\b/i.test(b),
  },
  {
    id: "phrase_finalizing_your_booking",
    test: (b) => /\bfinalizing\s+your\s+booking\b/i.test(b),
  },
  { id: "phrase_can_lock", test: (b) => /\bi\s+can\s+lock\b/i.test(b) },
  {
    id: "phrase_ll_lock",
    test: (b) => new RegExp(`\\bi${A}ll\\s+lock\\b`, "i").test(b),
  },
  {
    id: "phrase_your_booking_for_or_is",
    test: (b) => /\byour\s+booking\s+(?:for|is)\b/i.test(b),
  },
  {
    id: "phrase_ll_go_ahead_and_book",
    test: (b) => new RegExp(`\\bi${A}ll\\s+go\\s+ahead\\s+and\\s+book\\b`, "i").test(b),
  },
  {
    id: "phrase_ll_book_it",
    test: (b) => new RegExp(`\\bi${A}ll\\s+book\\s+it\\b`, "i").test(b),
  },
  { id: "phrase_got_you_booked", test: (b) => /\bgot\s+you\s+booked\b/i.test(b) },
  {
    id: "phrase_ive_got_you_booked",
    test: (b) =>
      new RegExp(`\\bi${A}ve\\s+got\\s+you\\s+booked\\b`, "i").test(b) ||
      /\bi\s+have\s+got\s+you\s+booked\b/i.test(b),
  },
  { id: "phrase_your_bay_is_booked", test: (b) => /\byour\s+bay\s+is\s+booked\b/i.test(b) },
  {
    id: "looking_forward_then_booking_context",
    test: lookingForwardSeeingYouThenBookingContext,
  },
  { id: "word_booked", test: (b) => /\bbooked\b/i.test(b) },
  { id: "word_confirmed", test: (b) => /\bconfirmed\b/i.test(b) },
  { id: "phrase_youre_set", test: (b) => new RegExp(`\\byou${A}re\\s+set\\b`, "i").test(b) },
  { id: "word_reserved", test: (b) => /\breserved\b/i.test(b) },
  { id: "phrase_its_booked", test: (b) => new RegExp(`\\bit${A}s\\s+booked\\b`, "i").test(b) },
  {
    id: "phrase_weve_booked",
    test: (b) =>
      new RegExp(`\\bwe${A}ve\\s+booked\\b`, "i").test(b),
  },
  { id: "phrase_already_booked", test: (b) => /\balready\s+booked\b/i.test(b) },
  {
    id: "phrase_been_booked_aux",
    test: (b) => /\bba\s+h(?:as|ave)\s+been\s+booked\b/i.test(b),
  },
  { id: "phrase_been_booked_for", test: (b) => /\bbeen\s+booked\s+for\b/i.test(b) },
  {
    id: "phrase_ll_book",
    test: (b) => new RegExp(`\\bi${A}ll\\s+book\\b`, "i").test(b),
  },
  { id: "phrase_im_booking", test: (b) => new RegExp(`\\bi${A}m\\s+booking\\b`, "i").test(b) },
];

function findOutboundConfirmationViolation(body: string): PatternRule["id"] | null {
  for (const rule of BOOKING_CONFIRMATION_RULES) {
    if (rule.test(body)) return rule.id;
  }
  return null;
}

export function outboundImpliesBookingConfirmation(text: string): boolean {
  if (!text.trim()) return false;
  const scan = stripAutomationDisclosureForScan(text) || text.trim();
  return findOutboundConfirmationViolation(scan) !== null;
}

export function stripAutomationDisclosureForScan(text: string): string {
  const m = /^Hi,\s*this\s+is\s+.+?\.\s+/i.exec(text);
  return (m ? text.slice(m[0].length) : text).trim();
}

/**
 * Applies the final outbound safety barrier for SMS replies.
 */
export function applyBookingConfirmationOutboundGuard(output: {
  replyTextFull: string;
  bookingConfirmedByWhoosh: boolean;
}): {
  replyTextFull: string;
  blocked: boolean;
  matchedPattern?: string;
} {
  const body =
    stripAutomationDisclosureForScan(output.replyTextFull) || output.replyTextFull.trim();
  if (output.bookingConfirmedByWhoosh || !body) {
    return { replyTextFull: output.replyTextFull, blocked: false };
  }

  const matchedId = findOutboundConfirmationViolation(body);
  if (!matchedId) {
    return { replyTextFull: output.replyTextFull, blocked: false };
  }

  const disclosure =
    /^Hi,\s*this\s+is\s+.+/i.exec(output.replyTextFull.trim())?.[0] ?? "";

  const replacementBody = BOOKING_CONFIRMATION_HANDOFF_REPLY;
  const rewritten = disclosure.trim()
    ? `${disclosure} ${replacementBody}`
    : replacementBody;

  return {
    replyTextFull: rewritten,
    blocked: true,
    matchedPattern: matchedId,
  };
}
