import type { SupabaseClient } from "@supabase/supabase-js";
import { isParenLessonCalendarTitle } from "./lesson-whoosh-identity";
import { truthFieldsForDb } from "./closeos-opportunity-truth";

const SOURCE = "google_calendar_booking" as const;

const PLAYBOOK_BY_SIGNAL = {
  lesson_rebooking_due: "lesson-rebooking-due",
  event_follow_up: "event-follow-up",
  clinic_progression: "clinic-progression",
  booking_cancelled_recovery: "booking-cancelled-recovery",
  booked_but_no_square_match: "calendar-identity-gap",
} as const;

export type GoogleCalendarBookingSignal =
  keyof typeof PLAYBOOK_BY_SIGNAL;

type BookingRow = {
  id?: string;
  external_id: string | null;
  customer_profile_id: string | null;
  reservation_type: string | null;
  status: string | null;
  starts_at: string | null;
  ends_at: string | null;
  title: string | null;
  description: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  source: string | null;
};

function daysEnv(key: string, fallback: number) {
  const raw = process.env[key];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isSimulatorLikeCalendarBooking(row: {
  title: string | null;
  description: string | null;
  reservation_type: string | null;
}) {
  const text = `${row.title ?? ""} ${row.description ?? ""}`.toLowerCase();
  if (text.includes("simulator") || text.includes(" sim bay") || text.includes("sim bay")) {
    return true;
  }
  return false;
}

function bookingRefMarker(externalId: string) {
  return `REF:google_calendar:${externalId}`;
}

async function findOpenBookingOpportunity(input: {
  supabase: SupabaseClient;
  businessId: string;
  recognizedOpportunity: GoogleCalendarBookingSignal;
  playbook: string;
  customerProfileId: string | null;
  signalContains?: string;
}) {
  let q = input.supabase
    .from("ai_opportunities")
    .select("id, status")
    .eq("business_id", input.businessId)
    .eq("recognized_opportunity", input.recognizedOpportunity)
    .eq("playbook", input.playbook)
    .eq("source", SOURCE)
    .in("status", ["open", "queued", "launched", "replied"])
    .limit(1);

  if (input.customerProfileId) {
    q = q.eq("customer_profile_id", input.customerProfileId);
  } else if (input.signalContains) {
    q = q.is("customer_profile_id", null).ilike(
      "signal_summary",
      `%${input.signalContains}%`
    );
  } else {
    return null;
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data?.[0] as { id: string; status: string } | undefined) ?? null;
}

async function upsertBookingOpportunity(input: {
  supabase: SupabaseClient;
  businessId: string;
  customerProfileId: string | null;
  signal: GoogleCalendarBookingSignal;
  opportunityType: string;
  priority: number;
  confidence: number;
  signalSummary: string;
  nextBestAction: string;
  replyHandlingGoal: string;
  recommendedMessage: string;
  dedupeSignalContains?: string;
}) {
  const playbook = PLAYBOOK_BY_SIGNAL[input.signal];
  const now = new Date().toISOString();
  const truth = truthFieldsForDb(input.signal);

  const existing = await findOpenBookingOpportunity({
    supabase: input.supabase,
    businessId: input.businessId,
    recognizedOpportunity: input.signal,
    playbook,
    customerProfileId: input.customerProfileId,
    signalContains: input.dedupeSignalContains,
  });

  if (existing?.status === "launched" || existing?.status === "replied") {
    const { error } = await input.supabase
      .from("ai_opportunities")
      .update({
        priority: input.priority,
        confidence: input.confidence,
        ...truth,
        signal_summary: input.signalSummary,
        next_best_action: input.nextBestAction,
        reply_handling_goal: input.replyHandlingGoal,
        last_evaluated_at: now,
        updated_at: now,
      })
      .eq("id", existing.id);

    if (error) throw new Error(error.message);
    return "touched_active" as const;
  }

  if (existing) {
    const { error } = await input.supabase
      .from("ai_opportunities")
      .update({
        priority: input.priority,
        confidence: input.confidence,
        ...truth,
        signal_summary: input.signalSummary,
        next_best_action: input.nextBestAction,
        reply_handling_goal: input.replyHandlingGoal,
        recommended_message: input.recommendedMessage,
        last_evaluated_at: now,
        updated_at: now,
      })
      .eq("id", existing.id);

    if (error) throw new Error(error.message);
    return "updated" as const;
  }

  const { error: insertError } = await input.supabase
    .from("ai_opportunities")
    .insert({
      business_id: input.businessId,
      customer_profile_id: input.customerProfileId,
      targeting_profile_id: null,
      recognized_opportunity: input.signal,
      opportunity_type: input.opportunityType,
      playbook,
      status: "open",
      priority: input.priority,
      confidence: input.confidence,
      ...truth,
      signal_summary: input.signalSummary,
      next_best_action: input.nextBestAction,
      reply_handling_goal: input.replyHandlingGoal,
      recommended_message: input.recommendedMessage,
      source: SOURCE,
      opened_at: now,
      last_evaluated_at: now,
      updated_at: now,
    });

  if (insertError) throw new Error(insertError.message);
  return "created" as const;
}

function parseIso(value: string | null) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Evaluates `booking_reservations` (Google Calendar source) and surfaces
 * `ai_opportunities` with status open and source google_calendar_booking.
 * Does not send outreach.
 */
export async function evaluateGoogleCalendarBookingOpportunities(input: {
  supabase: SupabaseClient;
  businessId: string;
}) {
  const { supabase, businessId } = input;
  const now = new Date();
  const lessonGapDays = daysEnv("CLOSEOS_LESSON_REBOOKING_GAP_DAYS", 21);
  const eventFollowUpDays = daysEnv("CLOSEOS_EVENT_FOLLOW_UP_WINDOW_DAYS", 14);
  const clinicWindowDays = daysEnv("CLOSEOS_CLINIC_PROGRESSION_WINDOW_DAYS", 21);
  const cancelledWindowDays = daysEnv("CLOSEOS_CANCELLED_RECOVERY_WINDOW_DAYS", 45);

  let created = 0;
  let updated = 0;
  let touchedActive = 0;

  const { data: rows, error } = await supabase
    .from("booking_reservations")
    .select(
      "id, external_id, customer_profile_id, reservation_type, status, starts_at, ends_at, title, description, customer_email, customer_phone, source"
    )
    .eq("business_id", businessId)
    .eq("source", "google_calendar");

  if (error) throw new Error(error.message);

  const bookings = (rows ?? []) as BookingRow[];

  const eligible = bookings.filter(
    (b) => !isSimulatorLikeCalendarBooking(b)
  );

  // --- booked_but_no_square_match (unmatched identity, has email or phone) ---
  for (const b of eligible) {
    if (b.customer_profile_id) continue;
    if (b.status !== "booked") continue;
    const ext = b.external_id ?? b.id ?? "";
    if (!ext) continue;
    const needsLessonIdentityReview =
      b.reservation_type === "lesson" &&
      isParenLessonCalendarTitle(b.title ?? "");

    if (
      !b.customer_email &&
      !b.customer_phone &&
      !needsLessonIdentityReview
    ) {
      continue;
    }

    const marker = bookingRefMarker(ext);
    const summary = `${marker} Calendar booking "${b.title ?? "(no title)"}" has extracted contact data but no customer_profile match. Improve identity matching (email first, then phone); do not match by name alone.`;

    const r = await upsertBookingOpportunity({
      supabase,
      businessId,
      customerProfileId: null,
      signal: "booked_but_no_square_match",
      opportunityType: "identity",
      priority: 62,
      confidence: 55,
      signalSummary: summary,
      nextBestAction:
        "Review extracted email/phone against Square and Mailchimp, then link or create customer_profiles safely.",
      replyHandlingGoal:
        "No automated outreach. Resolve identity before any campaign.",
      recommendedMessage: "",
      dedupeSignalContains: marker,
    });
    if (r === "created") created += 1;
    else if (r === "updated") updated += 1;
    else if (r === "touched_active") touchedActive += 1;
  }

  // --- Per customer_profile_id signals ---
  const byCustomer = new Map<string, BookingRow[]>();
  for (const b of eligible) {
    if (!b.customer_profile_id) continue;
    const list = byCustomer.get(b.customer_profile_id) ?? [];
    list.push(b);
    byCustomer.set(b.customer_profile_id, list);
  }

  for (const [customerId, list] of byCustomer) {
    const lessons = list.filter(
      (b) => b.reservation_type === "lesson" && b.ends_at && b.starts_at
    );
    const events = list.filter(
      (b) => b.reservation_type === "event" && b.ends_at && b.starts_at
    );
    const clinics = list.filter(
      (b) => b.reservation_type === "clinic" && b.ends_at && b.starts_at
    );

    // lesson_rebooking_due
    const pastBookedLessons = lessons.filter(
      (b) => b.status === "booked" && parseIso(b.ends_at)! < now
    );
    if (pastBookedLessons.length > 0) {
      const lastEnd = pastBookedLessons.reduce((max, b) => {
        const t = parseIso(b.ends_at)!.getTime();
        return t > max.t ? { t, row: b } : max;
      }, { t: 0, row: pastBookedLessons[0] }).row;

      const lastEndMs = parseIso(lastEnd.ends_at)!.getTime();
      const hasLaterLesson = lessons.some((b) => {
        if (b.status !== "booked") return false;
        const s = parseIso(b.starts_at);
        return s && s.getTime() > lastEndMs;
      });

      const daysSince =
        (now.getTime() - lastEndMs) / (24 * 60 * 60 * 1000);

      if (!hasLaterLesson && daysSince >= lessonGapDays) {
        const r = await upsertBookingOpportunity({
          supabase,
          businessId,
          customerProfileId: customerId,
          signal: "lesson_rebooking_due",
          opportunityType: "lesson",
          priority: 74,
          confidence: 72,
          signalSummary: `Last completed lesson ended ${lastEnd.ends_at}. No later lesson booked after ${Math.floor(daysSince)} days.`,
          nextBestAction:
            "Offer lesson rebooking based on history; do not auto-send until reviewed.",
          replyHandlingGoal:
            "If outreach is enabled later, focus on goals and preferred times.",
          recommendedMessage: "",
        });
        if (r === "created") created += 1;
        else if (r === "updated") updated += 1;
        else if (r === "touched_active") touchedActive += 1;
      }
    }

    // event_follow_up (recent completed event)
    const pastBookedEvents = events.filter(
      (b) => b.status === "booked" && parseIso(b.ends_at)! < now
    );
    if (pastBookedEvents.length > 0) {
      const recent = pastBookedEvents.filter((b) => {
        const end = parseIso(b.ends_at)!;
        const days = (now.getTime() - end.getTime()) / (24 * 60 * 60 * 1000);
        return days >= 0 && days <= eventFollowUpDays;
      });
      if (recent.length > 0) {
        const last = recent.reduce((a, b) =>
          parseIso(b.ends_at)!.getTime() > parseIso(a.ends_at)!.getTime()
            ? b
            : a
        );
        const r = await upsertBookingOpportunity({
          supabase,
          businessId,
          customerProfileId: customerId,
          signal: "event_follow_up",
          opportunityType: "event",
          priority: 70,
          confidence: 68,
          signalSummary: `Completed event "${last.title ?? ""}" ended ${last.ends_at}. Follow up or rebook within policy.`,
          nextBestAction:
            "Send a human-reviewed thank-you or rebooking prompt for events.",
          replyHandlingGoal: "No automated launch from this signal yet.",
          recommendedMessage: "",
        });
        if (r === "created") created += 1;
        else if (r === "updated") updated += 1;
        else if (r === "touched_active") touchedActive += 1;
      }
    }

    // clinic_progression
    const pastBookedClinics = clinics.filter(
      (b) => b.status === "booked" && parseIso(b.ends_at)! < now
    );
    if (pastBookedClinics.length > 0) {
      const recentClinic = pastBookedClinics.filter((b) => {
        const end = parseIso(b.ends_at)!;
        const days = (now.getTime() - end.getTime()) / (24 * 60 * 60 * 1000);
        return days >= 0 && days <= clinicWindowDays;
      });
      if (recentClinic.length > 0) {
        const last = recentClinic.reduce((a, b) =>
          parseIso(b.ends_at)!.getTime() > parseIso(a.ends_at)!.getTime()
            ? b
            : a
        );
        const r = await upsertBookingOpportunity({
          supabase,
          businessId,
          customerProfileId: customerId,
          signal: "clinic_progression",
          opportunityType: "clinic",
          priority: 71,
          confidence: 66,
          signalSummary: `Clinic "${last.title ?? ""}" completed ${last.ends_at}. Consider next-step lesson or clinic series.`,
          nextBestAction:
            "Propose appropriate next clinic or private lesson; manual review first.",
          replyHandlingGoal: "No automated outreach from calendar alone yet.",
          recommendedMessage: "",
        });
        if (r === "created") created += 1;
        else if (r === "updated") updated += 1;
        else if (r === "touched_active") touchedActive += 1;
      }
    }

    // booking_cancelled_recovery
    const cancelled = list.filter(
      (b) =>
        b.status === "cancelled" &&
        ["lesson", "event", "clinic"].includes(b.reservation_type ?? "") &&
        b.starts_at
    );
    for (const c of cancelled) {
      const start = parseIso(c.starts_at);
      if (!start) continue;
      const daysSinceStart =
        (now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
      if (daysSinceStart < 0 || daysSinceStart > cancelledWindowDays) continue;

      const hasReplacement = list.some((b) => {
        if (b.status !== "booked") return false;
        if (!b.starts_at) return false;
        const bs = parseIso(b.starts_at);
        return bs && bs.getTime() > start.getTime();
      });

      if (!hasReplacement) {
        const r = await upsertBookingOpportunity({
          supabase,
          businessId,
          customerProfileId: customerId,
          signal: "booking_cancelled_recovery",
          opportunityType: "reactivation",
          priority: 69,
          confidence: 64,
          signalSummary: `Cancelled ${c.reservation_type} on ${c.starts_at} ("${c.title ?? ""}") with no replacement booking found in synced calendar data.`,
          nextBestAction:
            "Recover booking with a human-reviewed message; confirm availability first.",
          replyHandlingGoal:
            "No automated recovery send until policy allows.",
          recommendedMessage: "",
        });
        if (r === "created") created += 1;
        else if (r === "updated") updated += 1;
        else if (r === "touched_active") touchedActive += 1;
      }
    }
  }

  return {
    source: SOURCE,
    created,
    updated,
    touchedActive,
    lessonGapDays,
    eventFollowUpDays,
    clinicWindowDays,
    cancelledWindowDays,
  };
}
