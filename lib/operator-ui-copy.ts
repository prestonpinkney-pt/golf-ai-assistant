/**
 * First sentence of strategic copy without a trailing ellipsis when the
 * first sentence already fits (tighter playbook card “Why now”).
 */
export function firstSentence(text: string | null | undefined, maxLen = 280): string {
  if (!text?.trim()) return "—";
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/^.{1,2000}?[.!?](?=\s|$)/);
  const first = m ? m[0]!.trim() : t;
  if (first.length <= maxLen) return first;
  return `${first.slice(0, maxLen - 1).trimEnd()}…`;
}

/** Single-line copy for operator UI (max ~1 sentence). */
export function oneSentence(text: string | null | undefined, maxLen = 140): string {
  if (!text?.trim()) return "—";
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/^.{1,200}?[.!?](?=\s|$)/);
  const first = m ? m[0]!.trim() : t.slice(0, maxLen).trim();
  const out = first.length >= t.length ? t : `${first.replace(/[,;:]$/g, "")}…`;
  return out.length > maxLen ? `${out.slice(0, maxLen - 1).trimEnd()}…` : out;
}

/** SMS / draft preview: tight cap (~2 short lines). */
export function clampDraft(text: string | null | undefined, maxLen = 120): string {
  return oneSentence(text, maxLen);
}

function lab(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export type WhyNowInput = {
  recognizedOpportunity: string;
  bookingStatus: string | null;
  lastBookingType: string | null;
  daysSinceBooking: number | null;
  bookingTitle: string | null;
};

/** One plain sentence — not the full `reason` paragraph (avoid duplicate with Details). */
export function buildWhyNowLine(input: WhyNowInput): string {
  const days = input.daysSinceBooking;
  const ago =
    days != null && days >= 0
      ? `${days} day${days === 1 ? "" : "s"} ago`
      : "recently";
  const ro = input.recognizedOpportunity;
  const st = (input.bookingStatus ?? "").toLowerCase();

  if (ro === "booking_cancelled_recovery" || st === "cancelled") {
    return `Cancelled ${lab(input.lastBookingType ?? "lesson")} ${ago} — no replacement booking yet.`;
  }
  if (ro === "lesson_rebooking_due") {
    return `Last lesson ended ${ago}; time to rebook.`;
  }
  if (ro === "event_follow_up") {
    return `Event ended ${ago}; good window for repeat group bookings.`;
  }
  if (ro === "clinic_progression") {
    return `Clinic completed ${ago}; suggest lesson or next clinic.`;
  }
  if (ro.startsWith("mailchimp_")) {
    const tag = ro.replace(/^mailchimp_/, "").replace(/_/g, " ");
    return `Mailchimp intent: ${tag}.`;
  }
  if (ro === "recent_buyer_follow_up") {
    return `Recent buyer — suggest the next visit.`;
  }
  if (ro === "practice_to_lesson") {
    return `Practice activity — lesson upsell fit.`;
  }
  if (ro === "member_lesson_rebooking") {
    return `Member — next lesson not on calendar yet.`;
  }
  if (ro === "inactive_customer_reactivation") {
    return `Quiet account — light win-back touch.`;
  }
  const title = input.bookingTitle?.trim();
  if (title && days != null && days >= 0) {
    const short = title.length > 36 ? `${title.slice(0, 33)}…` : title;
    return `Calendar booking ${ago}: “${short}”.`;
  }
  return "Ready for a short outbound touch.";
}
