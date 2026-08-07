import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { NormalizedWhooshAvailabilitySlot } from "@/lib/whoosh/availability";

export type CloseOsBookingStatus =
  | "held_pending_payment"
  | "square_link_failed"
  | "paid_pending_whoosh"
  | "paid_confirmed"
  | "payment_needs_review"
  | "paid_whoosh_failed"
  | "hold_cancelled";

export function slotIntervalsOverlapUtc(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  const as = Date.parse(aStart);
  const ae = Date.parse(aEnd);
  const bs = Date.parse(bStart);
  const be = Date.parse(bEnd);
  if (![as, ae, bs, be].every(Number.isFinite)) return false;
  return as < be && ae > bs;
}

export async function hasActiveSimulatorHoldConflict(
  supabase: SupabaseClient,
  input: {
    businessId: string;
    bayResourceId: string;
    slotStartIso: string;
    slotEndIso: string;
    excludeCloseosBookingId?: string | null;
  }
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("closeos_bookings")
    .select("id, start_time, end_time, status, expires_at")
    .eq("business_id", input.businessId)
    .eq("bay_id", input.bayResourceId)
    .in("status", [
      "held_pending_payment",
      "paid_pending_whoosh",
      "paid_confirmed",
      /** Paid customer still owns the bay until ops reconcile Whoosh. */
      "paid_whoosh_failed",
    ]);

  if (error) throw new Error(error.message);

  for (const row of data ?? []) {
    const id = typeof row.id === "string" ? row.id : String(row.id);
    if (
      input.excludeCloseosBookingId &&
      id === input.excludeCloseosBookingId
    ) {
      continue;
    }
    const st = typeof row.status === "string" ? row.status : "";
    const rss = typeof row.start_time === "string" ? row.start_time : "";
    const rse = typeof row.end_time === "string" ? row.end_time : "";
    const holdExp =
      typeof row.expires_at === "string" ? row.expires_at : "";

    if (st === "held_pending_payment") {
      if (Date.parse(holdExp) <= Date.parse(nowIso)) continue;
    }

    if (!slotIntervalsOverlapUtc(input.slotStartIso, input.slotEndIso, rss, rse))
      continue;

    if (st === "paid_pending_whoosh") return true;

    /** Overlapping active unpaid hold blocks new holds */
    if (st === "held_pending_payment") return true;

    /**
     * Overlapping paid_confirmed retains the bay reservation —
     * do not mint another hold overlapping it.
     */
    if (st === "paid_confirmed") return true;

    /** Paid but Whoosh failed — keep exclusive claim so a second guest cannot oversell. */
    if (st === "paid_whoosh_failed") return true;
  }

  return false;
}

/**
 * Compare-and-swap claim: only one Square webhook worker may move
 * `held_pending_payment` → `paid_pending_whoosh` before calling Whoosh.
 */
export async function claimCloseOsBookingPaidPendingWhoosh(
  supabase: SupabaseClient,
  id: string,
  fields: Record<string, unknown>
): Promise<"claimed" | "lost_race"> {
  const { data, error } = await supabase
    .from("closeos_bookings")
    .update(fields as never)
    .eq("id", id)
    .eq("status", "held_pending_payment")
    .select("id")
    .maybeSingle();

  if (error?.message) throw new Error(error.message);
  if (data && typeof (data as { id?: unknown }).id === "string") return "claimed";
  return "lost_race";
}

export type CloseOsBookingInsert = {
  business_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  agenda_date?: string | null;
  service_type?: string | null;
  start_time: string;
  end_time: string;
  bay_id: string;
  slot_id_external?: string | null;
  party_size: number;
  duration_minutes: number;
  slot_snapshot: Record<string, unknown>;
  amount_due_cents: number;
  currency?: string;
  status: CloseOsBookingStatus;
  payment_provider?: string;
  payment_status?: string;
  expires_at: string;
};

export async function insertCloseOsBookingHold(
  supabase: SupabaseClient,
  row: CloseOsBookingInsert
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("closeos_bookings")
    .insert({
      business_id: row.business_id,
      conversation_id: row.conversation_id,
      contact_id: row.contact_id,
      service_type: row.service_type ?? "simulator",
      start_time: row.start_time,
      end_time: row.end_time,
      bay_id: row.bay_id,
      party_size: row.party_size,
      duration_minutes: row.duration_minutes,
      amount_due_cents: row.amount_due_cents,
      currency: row.currency ?? "USD",
      status: row.status,
      payment_provider: row.payment_provider ?? "square",
      payment_status: row.payment_status ?? "pending",
      expires_at: row.expires_at,
      raw_payload: {
        agenda_date: row.agenda_date ?? null,
        slot_id_external: row.slot_id_external ?? null,
        slot_snapshot: row.slot_snapshot,
      },
      updated_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();

  if (error?.message || !data) {
    throw new Error(error?.message ?? "closeos_bookings insert missing row");
  }
  const rid = data as unknown as { id: string };
  if (!rid.id) throw new Error("closeos_bookings insert missing id.");
  return { id: rid.id };
}

export async function updateCloseOsBookingPaymentFields(
  supabase: SupabaseClient,
  id: string,
  fields: {
    payment_link_url: string | null;
    payment_link_id: string | null;
    payment_provider?: string;
    payment_status?: string;
    status?: CloseOsBookingStatus;
    last_error_summary?: string | null;
    raw_payload?: Record<string, unknown>;
    updated_at?: string;
  }
): Promise<void> {
  const { error } = await supabase.from("closeos_bookings").update(fields as never).eq("id", id);
  if (error?.message) throw new Error(error.message);
}

export async function getCloseOsBookingById(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase
    .from("closeos_bookings")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error?.message) throw new Error(error.message);
  return data as Record<string, unknown> | null;
}

export async function finalizeCloseOsBookingAfterWhooshConfirm(
  supabase: SupabaseClient,
  id: string,
  fields: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from("closeos_bookings").update(fields as never).eq("id", id);
  if (error?.message) throw new Error(error.message);
}

/** Extract slot identifiers for Square metadata + collision keys. */
export function pickSlotCorrelationIds(slot: NormalizedWhooshAvailabilitySlot): {
  bayResourceId: string;
  slotIdExternal: string | null;
} {
  const raw = slot.raw && typeof slot.raw === "object" && !Array.isArray(slot.raw) ?
      (slot.raw as Record<string, unknown>)
    : {};

  const id =
    [raw.id, raw.slot_id, raw.uuid, raw.agenda_slot_id]
      .map((x) =>
        typeof x === "string" && x.trim() ? x.trim() : x !== null ? String(x).trim() : ""
      )
      .find(Boolean) ?? "";

  const bayResourceId = typeof slot.bayOrResourceId === "string" && slot.bayOrResourceId.trim() ?
      slot.bayOrResourceId.trim()
    : "";

  return {
    bayResourceId,
    slotIdExternal: id || null,
  };
}
