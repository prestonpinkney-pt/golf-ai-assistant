import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeWhooshAgendaOpportunities,
  type OpportunitiesComputeResult,
} from "@/lib/whoosh/opportunities";

export type LoadWhooshAgendaOpportunitiesResult =
  | { ok: false; error_message: string }
  | {
      ok: true;
      result: OpportunitiesComputeResult;
      ingest: {
        slot_rows_loaded: number;
        booking_rows_loaded: number;
      };
    };

/**
 * Read normalized Whoosh agenda rows from Supabase and run the opportunity engine.
 * Does not call Whoosh HTTP — DB read + pure compute only.
 */
export async function loadWhooshAgendaOpportunities(
  supabase: SupabaseClient,
  input: { business_id: string; agenda_date: string }
): Promise<LoadWhooshAgendaOpportunitiesResult> {
  const { business_id, agenda_date } = input;

  const { data: slotRows, error: slotErr } = await supabase
    .from("whoosh_agenda_slots")
    .select(
      "whoosh_facility_slug, course_id, course_name, slot_date, time, capacity, used_capacity"
    )
    .eq("business_id", business_id)
    .eq("agenda_date", agenda_date);

  if (slotErr) {
    return { ok: false, error_message: slotErr.message };
  }

  const { data: bookingRows, error: bookErr } = await supabase
    .from("whoosh_agenda_bookings")
    .select("course_id, booking_time, deleted_at")
    .eq("business_id", business_id)
    .eq("agenda_date", agenda_date);

  if (bookErr) {
    return { ok: false, error_message: bookErr.message };
  }

  const slots = slotRows ?? [];
  const facility_slug =
    slots.find((r) => r.whoosh_facility_slug)?.whoosh_facility_slug?.trim() ||
    process.env.WHOOSH_FACILITY_SLUG?.trim() ||
    "unknown";

  const result = computeWhooshAgendaOpportunities({
    agenda_date,
    facility_slug,
    slots: slots.map((r) => ({
      course_id: r.course_id,
      course_name: r.course_name,
      slot_date: r.slot_date,
      time: r.time,
      capacity: r.capacity,
      used_capacity: r.used_capacity,
    })),
    bookings: (bookingRows ?? []).map((r) => ({
      course_id: r.course_id,
      booking_time: r.booking_time,
      deleted_at: r.deleted_at,
    })),
  });

  return {
    ok: true,
    result,
    ingest: {
      slot_rows_loaded: slots.length,
      booking_rows_loaded: bookingRows?.length ?? 0,
    },
  };
}
