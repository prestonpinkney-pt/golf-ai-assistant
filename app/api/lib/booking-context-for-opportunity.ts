export type BookingReservationLite = {
  customer_profile_id: string | null;
  reservation_type: string | null;
  status: string | null;
  starts_at: string | null;
  ends_at: string | null;
  title: string | null;
};

function parseTime(iso: string | null) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function sortByStartsDesc(a: BookingReservationLite, b: BookingReservationLite) {
  const ta = parseTime(a.starts_at) ?? 0;
  const tb = parseTime(b.starts_at) ?? 0;
  return tb - ta;
}

export function pickBookingContextForOpportunity(input: {
  recognizedOpportunity: string;
  opportunitySource: string | null;
  customerBookings: BookingReservationLite[];
}): BookingReservationLite | null {
  const { recognizedOpportunity, opportunitySource, customerBookings } = input;
  const list = [...customerBookings].sort(sortByStartsDesc);
  if (list.length === 0) return null;

  const now = Date.now();
  const isGoogleOpp = opportunitySource === "google_calendar_booking";

  if (recognizedOpportunity === "booking_cancelled_recovery") {
    return (
      list.find(
        (b) =>
          b.status === "cancelled" &&
          ["lesson", "event", "clinic"].includes(
            (b.reservation_type ?? "").toLowerCase()
          )
      ) ?? null
    );
  }

  if (recognizedOpportunity === "lesson_rebooking_due") {
    return (
      list.find((b) => {
        if (b.reservation_type !== "lesson" || b.status !== "booked")
          return false;
        const end = parseTime(b.ends_at);
        return end !== null && end < now;
      }) ?? null
    );
  }

  if (recognizedOpportunity === "clinic_progression") {
    return (
      list.find((b) => {
        if (b.reservation_type !== "clinic" || b.status !== "booked")
          return false;
        const end = parseTime(b.ends_at);
        return end !== null && end < now;
      }) ?? null
    );
  }

  if (recognizedOpportunity === "event_follow_up") {
    return (
      list.find((b) => {
        if (b.reservation_type !== "event" || b.status !== "booked") return false;
        const end = parseTime(b.ends_at);
        return end !== null && end < now;
      }) ?? null
    );
  }

  if (isGoogleOpp) {
    return list[0] ?? null;
  }

  return null;
}

export function computeDaysSinceBooking(booking: BookingReservationLite | null) {
  if (!booking) return null;
  const end = parseTime(booking.ends_at);
  const start = parseTime(booking.starts_at);
  const anchor =
    end !== null && end < Date.now()
      ? end
      : start !== null
        ? start
        : null;
  if (anchor === null) return null;
  return Math.floor((Date.now() - anchor) / (24 * 60 * 60 * 1000));
}
