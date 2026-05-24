import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractWhooshIntegrationList } from "@/lib/whoosh/agenda-sanitize";
import { resolveWhooshAgendaDefaultTimezone } from "@/lib/whoosh/agenda-date";
import {
  getWhooshAgendaFacilitySlugFromEnv,
  whooshIntegrationAgendaPath,
  whooshServerFetch,
} from "@/lib/whoosh/client";

const UPSERT_CHUNK = 150;

function nowIso() {
  return new Date().toISOString();
}

function asTrimmedText(v: unknown, maxLen: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function asIntNullable(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

/** Count array length only — never persists raw payloads. */
function partyCount(raw: Record<string, unknown>, key: string): number | null {
  const v = raw[key];
  if (Array.isArray(v)) return v.length;
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
  return null;
}

function parseTimestamptzOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function toJsonbOrNull(v: unknown): Record<string, unknown> | unknown[] | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v as Record<string, unknown> | unknown[];
  return null;
}

function asBoolNullable(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1") return true;
  if (v === 0 || v === "0") return false;
  return null;
}

function summarizeSyncError(prefix: string, err: unknown, maxLen = 400): string {
  let msg =
    err && typeof err === "object" && "message" in err
      ? String((err as { message?: unknown }).message)
      : err instanceof Error
        ? err.message
        : "Unknown error";
  msg = msg.replace(/authorization\s*:\s*\S+/gi, "[redacted]");
  msg = msg.replace(/bearer\s+\S+/gi, "bearer [redacted]");
  return msg.length > maxLen ? `${prefix}: ${msg.slice(0, maxLen)}…` : `${prefix}: ${msg}`;
}

function mapWhooshSlotRow(input: {
  row: Record<string, unknown>;
  businessId: string;
  facilitySlug: string;
  agendaDate: string;
  syncRunId: string | null;
}): Record<string, unknown> | null {
  const idRaw = input.row.id;
  const whoosh_slot_id =
    idRaw !== null && idRaw !== undefined ? String(idRaw).trim() : "";
  if (!whoosh_slot_id) return null;

  return {
    business_id: input.businessId,
    whoosh_facility_slug: input.facilitySlug,
    agenda_date: input.agendaDate,
    whoosh_slot_id,
    sync_run_id: input.syncRunId,
    course_id: asTrimmedText(input.row.course_id, 160),
    course_name: asTrimmedText(input.row.course_name, 400),
    slot_date: asTrimmedText(input.row.date, 64),
    time: asTrimmedText(input.row.time, 64),
    type: asTrimmedText(input.row.type, 120),
    capacity: asIntNullable(input.row.capacity),
    used_capacity: asIntNullable(input.row.used_capacity),
    block_name: asTrimmedText(input.row.block_name, 400),
    event_name: asTrimmedText(input.row.event_name, 400),
    group_label: asTrimmedText(input.row.group_label, 400),
    rates: toJsonbOrNull(input.row.rates),
    start_hole: asTrimmedText(input.row.start_hole, 120),
    last_synced_at: nowIso(),
  };
}

function mapWhooshBookingRow(input: {
  row: Record<string, unknown>;
  businessId: string;
  facilitySlug: string;
  agendaDate: string;
  syncRunId: string | null;
}): Record<string, unknown> | null {
  const idRaw = input.row.id;
  const whoosh_booking_id =
    idRaw !== null && idRaw !== undefined ? String(idRaw).trim() : "";
  if (!whoosh_booking_id) return null;

  const reqRaw = input.row.requested_time;
  const rtIso = parseTimestamptzOrNull(reqRaw);

  return {
    business_id: input.businessId,
    whoosh_facility_slug: input.facilitySlug,
    agenda_date: input.agendaDate,
    whoosh_booking_id,
    sync_run_id: input.syncRunId,
    course_id: asTrimmedText(input.row.course_id, 160),
    course_name: asTrimmedText(input.row.course_name, 400),
    booking_date: asTrimmedText(input.row.date, 64),
    booking_time: asTrimmedText(input.row.time, 64),
    duration_mins: asIntNullable(input.row.duration_mins),
    type: asTrimmedText(input.row.type, 120),
    slot_type: asTrimmedText(input.row.slot_type, 120),
    guests_count: partyCount(input.row, "guests"),
    members_count: partyCount(input.row, "members"),
    instructors_count: partyCount(input.row, "instructors"),
    is_no_show: asBoolNullable(input.row.is_no_show),
    deleted_at: parseTimestamptzOrNull(input.row.deleted_at),
    inserted_at: parseTimestamptzOrNull(input.row.inserted_at),
    updated_at: parseTimestamptzOrNull(input.row.updated_at),
    requested_time: rtIso,
    requested_time_raw:
      typeof reqRaw === "string" && reqRaw.trim() && !rtIso ? reqRaw.trim().slice(0, 240) : null,
    source: asTrimmedText(input.row.source, 200),
    event_name: asTrimmedText(input.row.event_name, 400),
    group_label: asTrimmedText(input.row.group_label, 400),
    start_hole: asTrimmedText(input.row.start_hole, 120),
    whoosh_booking_sort_index: asIntNullable(input.row.index),
    last_synced_at: nowIso(),
  };
}

export type WhooshAgendaSyncOutcome = {
  ok: boolean;
  agenda_date: string;
  sync_run_id: string;
  status: "completed" | "partial" | "failed";
  timezone_used: string;
  counts: {
    slotsFetched: number;
    bookingsFetched: number;
    slotsUpserted: number;
    bookingsUpserted: number;
  };
  error_summary?: string;
};

async function upsertChunks(
  supabase: SupabaseClient,
  table: "whoosh_agenda_slots" | "whoosh_agenda_bookings",
  rows: Record<string, unknown>[],
  onConflict: string
): Promise<number> {
  let total = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const slice = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase.from(table).upsert(slice, {
      onConflict,
    });
    if (error) {
      throw new Error(`${table} upsert: ${error.message}`);
    }
    total += slice.length;
  }
  return total;
}

export async function syncWhooshAgendaForDate(input: {
  supabase: SupabaseClient;
  businessId: string;
  agendaDate: string;
}): Promise<WhooshAgendaSyncOutcome> {
  const timezone_used = resolveWhooshAgendaDefaultTimezone().ianaTimezone;
  const facilitySlug = getWhooshAgendaFacilitySlugFromEnv();
  const agenda_date = input.agendaDate;
  let sync_run_id = "";
  const counts = {
    slotsFetched: 0,
    bookingsFetched: 0,
    slotsUpserted: 0,
    bookingsUpserted: 0,
  };

  let fatalSummary: string | undefined;

  try {
    const { data: runRow, error: runErr } = await input.supabase
      .from("whoosh_sync_runs")
      .insert({
        business_id: input.businessId,
        whoosh_facility_slug: facilitySlug,
        agenda_date,
        timezone_used,
        status: "running",
      })
      .select("id")
      .single();

    if (runErr || !runRow?.id) {
      throw new Error(runErr?.message ?? "whoosh_sync_runs insert failed");
    }
    sync_run_id = runRow.id as string;
    const syncRunIdStr = sync_run_id;

    let slotErr: string | undefined;
    let bookErr: string | undefined;

    const slotsRes = await whooshServerFetch(
      whooshIntegrationAgendaPath(agenda_date, "slots"),
      { method: "GET" }
    );

    if (!slotsRes.ok) {
      slotErr = `Whoosh slots HTTP ${slotsRes.status}`;
    } else {
      const slotsText = await slotsRes.text();
      let slotsParsed: unknown;
      try {
        slotsParsed = slotsText ? JSON.parse(slotsText) : null;
      } catch {
        slotErr = "Whoosh slots response was not valid JSON";
      }
      if (!slotErr) {
        const list = extractWhooshIntegrationList(slotsParsed);
        counts.slotsFetched = list.length;
        const mapped: Record<string, unknown>[] = [];
        for (const raw of list) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const mappedRow = mapWhooshSlotRow({
            row: raw as Record<string, unknown>,
            businessId: input.businessId,
            facilitySlug,
            agendaDate: agenda_date,
            syncRunId: syncRunIdStr,
          });
          if (mappedRow) mapped.push(mappedRow);
        }
        counts.slotsUpserted = await upsertChunks(
          input.supabase,
          "whoosh_agenda_slots",
          mapped,
          "business_id,whoosh_slot_id,agenda_date"
        );
      }
    }

    const bookingsRes = await whooshServerFetch(
      whooshIntegrationAgendaPath(agenda_date, "bookings"),
      { method: "GET" }
    );

    if (!bookingsRes.ok) {
      bookErr = `Whoosh bookings HTTP ${bookingsRes.status}`;
    } else {
      const bookingsText = await bookingsRes.text();
      let bookingsParsed: unknown;
      try {
        bookingsParsed = bookingsText ? JSON.parse(bookingsText) : null;
      } catch {
        bookErr = "Whoosh bookings response was not valid JSON";
      }
      if (!bookErr) {
        const blist = extractWhooshIntegrationList(bookingsParsed);
        counts.bookingsFetched = blist.length;
        const bmapped: Record<string, unknown>[] = [];
        for (const raw of blist) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const mappedRow = mapWhooshBookingRow({
            row: raw as Record<string, unknown>,
            businessId: input.businessId,
            facilitySlug,
            agendaDate: agenda_date,
            syncRunId: syncRunIdStr,
          });
          if (mappedRow) bmapped.push(mappedRow);
        }
        counts.bookingsUpserted = await upsertChunks(
          input.supabase,
          "whoosh_agenda_bookings",
          bmapped,
          "business_id,whoosh_booking_id"
        );
      }
    }

    let status: "completed" | "partial" | "failed";
    let ok: boolean;

    if (!slotErr && !bookErr) {
      status = "completed";
      ok = true;
    } else if (slotErr && bookErr) {
      status = "failed";
      ok = false;
      fatalSummary = [slotErr, bookErr].join("; ").slice(0, 800);
    } else {
      status = "partial";
      ok = true;
      fatalSummary = (slotErr ?? bookErr)?.slice(0, 800);
    }

    await input.supabase
      .from("whoosh_sync_runs")
      .update({
        status,
        slots_source_count: counts.slotsFetched,
        bookings_source_count: counts.bookingsFetched,
        slots_upserted: counts.slotsUpserted,
        bookings_upserted: counts.bookingsUpserted,
        error_summary: fatalSummary ?? null,
        finished_at: nowIso(),
      })
      .eq("id", sync_run_id);

    return {
      ok,
      agenda_date,
      sync_run_id,
      status,
      timezone_used,
      counts,
      ...(fatalSummary ? { error_summary: fatalSummary } : {}),
    };
  } catch (e) {
    const msg = summarizeSyncError("sync", e);
    if (sync_run_id) {
      await input.supabase
        .from("whoosh_sync_runs")
        .update({
          status: "failed",
          error_summary: msg,
          finished_at: nowIso(),
          slots_source_count: counts.slotsFetched,
          bookings_source_count: counts.bookingsFetched,
          slots_upserted: counts.slotsUpserted,
          bookings_upserted: counts.bookingsUpserted,
        })
        .eq("id", sync_run_id);
    }
    return {
      ok: false,
      agenda_date,
      sync_run_id: sync_run_id || "",
      status: "failed",
      timezone_used,
      counts,
      error_summary: msg,
    };
  }
}
