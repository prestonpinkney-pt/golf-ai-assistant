/**
 * Booking-aware ranking and per-customer deduplication for opportunity targets.
 */

export const RECOGNIZED_OPPORTUNITY_RANK: string[] = [
  "booking_cancelled_recovery",
  "lesson_rebooking_due",
  "clinic_progression",
  "event_follow_up",
  "booked_but_no_square_match",
  "mailchimp_lesson_interest",
  "mailchimp_event_interest",
  "mailchimp_simulator_interest",
  "practice_to_lesson",
  "member_lesson_rebooking",
  "recent_buyer_follow_up",
  "mailchimp_clinic_interest",
  "mailchimp_junior_program_interest",
  "mailchimp_membership_interest",
  "mailchimp_reactivation_interest",
  "mailchimp_general_lead",
  "repeat_guest_to_member",
  "event_rebooking",
  "clinic_follow_up",
];

export type OpportunitySourceRank = {
  source: string | null;
  recognized_opportunity: string;
  opportunity_type: string;
  priority: number;
  updated_at: string;
  customer_profile_id: string | null;
};

function recognizedIndex(recognized: string) {
  const i = RECOGNIZED_OPPORTUNITY_RANK.indexOf(recognized);
  return i === -1 ? RECOGNIZED_OPPORTUNITY_RANK.length + 50 : i;
}

/** Lower = stronger source tier (google > mailchimp > purchase). */
export function sourceTier(source: string | null) {
  const s = (source ?? "").toLowerCase();
  if (s === "google_calendar_booking") return 0;
  if (s === "mailchimp") return 1;
  if (s === "closeos" || s === "square") return 2;
  return 3;
}

/** Higher = better sort order (sort descending). */
export function opportunityRankScore(row: OpportunitySourceRank) {
  const rec = recognizedIndex(row.recognized_opportunity);
  const tier = sourceTier(row.source);
  const pri = Math.min(Math.max(row.priority, 0), 999);
  const ts = new Date(row.updated_at).getTime() || 0;
  // Lexicographic-style single number: spread tiers so sort is stable
  return (
    (1000 - rec) * 1_000_000 +
    (10 - tier) * 100_000 +
    pri * 100 +
    Math.min(ts / 1000, 99_999) / 99_999
  );
}

export function compareOpportunityRank(
  a: OpportunitySourceRank,
  b: OpportunitySourceRank
) {
  return opportunityRankScore(b) - opportunityRankScore(a);
}

function isLessonEventDualExceptionPair(
  a: OpportunitySourceRank,
  b: OpportunitySourceRank
) {
  if (a.priority < 80 || b.priority < 80) return false;
  const ta = (a.opportunity_type || "").toLowerCase();
  const tb = (b.opportunity_type || "").toLowerCase();
  if (ta === tb) return false;
  const oneLesson = ta === "lesson" || tb === "lesson";
  const oneEvent = ta === "event" || tb === "event";
  return oneLesson && oneEvent;
}

/**
 * For one customer's opportunities (already sorted best-first),
 * return 1–2 rows: best, plus second only for lesson+event exception.
 */
export function dedupeOpportunitiesForCustomer(
  rowsForCustomer: OpportunitySourceRank[]
): OpportunitySourceRank[] {
  const sorted = [...rowsForCustomer].sort(compareOpportunityRank);
  if (sorted.length === 0) return [];
  const best = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const cand = sorted[i]!;
    if (isLessonEventDualExceptionPair(best, cand)) {
      return [best, cand];
    }
  }
  return [best];
}

export function dedupeOpportunitiesAcrossCustomers<
  T extends OpportunitySourceRank,
>(rows: T[]): T[] {
  const sorted = [...rows].sort(compareOpportunityRank);
  const byCustomer = new Map<string, T[]>();

  for (const row of sorted) {
    const cid = row.customer_profile_id;
    if (!cid) continue;
    const list = byCustomer.get(cid) ?? [];
    list.push(row);
    byCustomer.set(cid, list);
  }

  const out: T[] = [];
  for (const [, list] of byCustomer) {
    const picked = dedupeOpportunitiesForCustomer(list) as T[];
    out.push(...picked);
  }

  out.sort(compareOpportunityRank);
  return out;
}
