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

function trimmedId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value !== null && value !== undefined) {
    const s = String(value).trim();
    if (s) return s;
  }
  return "";
}

/** Collect bay / course / occurrence ids stored on a CloseOS hold row. */
export function holdRowBayMatchKeys(row: {
  bay_id?: unknown;
  raw_payload?: unknown;
}): string[] {
  const keys = new Set<string>();
  const bayId = trimmedId(row.bay_id);
  if (bayId) keys.add(bayId);

  const payload =
    row.raw_payload !== null &&
    typeof row.raw_payload === "object" &&
    !Array.isArray(row.raw_payload) ?
      (row.raw_payload as Record<string, unknown>)
    : null;
  if (!payload) return [...keys];

  const snap =
    payload.slot_snapshot !== null &&
    typeof payload.slot_snapshot === "object" &&
    !Array.isArray(payload.slot_snapshot) ?
      (payload.slot_snapshot as Record<string, unknown>)
    : null;
  if (!snap) return [...keys];

  const snapBay = trimmedId(snap.bayOrResourceId);
  if (snapBay) keys.add(snapBay);

  const raw =
    snap.raw !== null && typeof snap.raw === "object" && !Array.isArray(snap.raw) ?
      (snap.raw as Record<string, unknown>)
    : null;
  if (raw) {
    for (const field of ["course_id", "bay_id", "id", "slot_id", "uuid", "agenda_slot_id"]) {
      const v = trimmedId(raw[field]);
      if (v) keys.add(v);
    }
  }

  return [...keys];
}

export async function hasActiveSimulatorHoldConflict(
  supabase: SupabaseClient,
  input: {
    businessId: string;
    bayResourceId: string;
    /**
     * All identifiers that refer to the same physical bay or this slot occurrence.
     * Used so adjacent Whoosh starts on one course_id collide even when bay_id was
     * historically stored as a per-start occurrence id.
     */
    conflictBayIds?: string[];
    slotStartIso: string;
    slotEndIso: string;
    excludeCloseosBookingId?: string | null;
  }
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const matchIds = new Set(
    [input.bayResourceId, ...(input.conflictBayIds ?? [])]
      .map((x) => trimmedId(x))
      .filter(Boolean)
  );
  if (matchIds.size === 0) return false;

  const { data, error } = await supabase
    .from("closeos_bookings")
    .select("id, start_time, end_time, status, expires_at, bay_id, raw_payload")
    .eq("business_id", input.businessId)
    .in("status", ["held_pending_payment", "paid_pending_whoosh", "paid_confirmed"]);

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

    const rowKeys = holdRowBayMatchKeys(row as { bay_id?: unknown; raw_payload?: unknown });
    if (!rowKeys.some((k) => matchIds.has(k))) continue;

    if (st === "paid_pending_whoosh") return true;

    /** Overlapping active unpaid hold blocks new holds */
    if (st === "held_pending_payment") return true;

    /**
     * Overlapping paid_confirmed retains the bay reservation —
     * do not mint another hold overlapping it.
     */
    if (st === "paid_confirmed") return true;
  }

  return false;
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
  /**
   * Physical bay / course id when Whoosh provides `course_id`; otherwise the
   * normalized `bayOrResourceId` (often a per-start occurrence id).
   */
  bayResourceId: string;
  slotIdExternal: string | null;
  /** Union of physical bay + occurrence ids for soft-hold conflict matching. */
  conflictBayIds: string[];
} {
  const raw = slot.raw && typeof slot.raw === "object" && !Array.isArray(slot.raw) ?
      (slot.raw as Record<string, unknown>)
    : {};

  const id =
    [raw.id, raw.slot_id, raw.uuid, raw.agenda_slot_id]
      .map((x) => trimmedId(x))
      .find(Boolean) ?? "";

  const courseId = [raw.course_id]
    .map((x) => trimmedId(x))
    .find(Boolean) ?? "";

  const bayOrResourceId =
    typeof slot.bayOrResourceId === "string" && slot.bayOrResourceId.trim() ?
      slot.bayOrResourceId.trim()
    : "";

  /** Prefer durable physical bay so overlapping adjacent starts collide. */
  const bayResourceId = courseId || bayOrResourceId;

  const conflictBayIds = [
    ...new Set([bayResourceId, bayOrResourceId, courseId, id].filter(Boolean)),
  ];

  return {
    bayResourceId,
    slotIdExternal: id || null,
    conflictBayIds,
  };
}
