import "server-only";

import { DateTime } from "luxon";

import { extractWhooshIntegrationList } from "@/lib/whoosh/agenda-sanitize";
import {
  getWhooshAgendaFacilitySlugFromEnv,
  isWhooshServerConfigured,
  whooshIntegrationAgendaPath,
  whooshServerFetch,
} from "@/lib/whoosh/client";
import {
  parseSlotLocalDateTime,
  type WhooshAggSlotRow,
} from "@/lib/whoosh/opportunities";
import {
  formatEstimatedSimulatorPrice,
  PRIMETIME_LESSON_USD,
  isSlotEligibleForSmsPublicSimulator,
} from "@/lib/primetime/pricing";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export type WhooshServiceType = "simulator" | "lesson" | "event";

/** Parameters for fetching live availability snapshots from Whoosh (GET agenda). */
export type WhooshAvailabilityParams = {
  serviceType: WhooshServiceType;
  /** `YYYY-MM-DD` (Primetime-local calendar semantics; echoed to agenda path). */
  date: string;
  partySize: number;
  durationMinutes: number;
  preferredTimeRange?: string | null;
  instructor?: string | null;
  customerContactLabel?: string | null;
};

export type NormalizedWhooshAvailabilitySlot = {
  startTime: string;
  endTime: string;
  bayOrResourceId: string;
  resourceName: string | null;
  serviceType: WhooshServiceType;
  priceEstimate: string | null;
  raw: Record<string, unknown>;
};

export type WhooshAvailabilityResult =
  | {
      ok: true;
      slots: NormalizedWhooshAvailabilitySlot[];
      fetchedAtIso: string;
      agenda_date: string;
      slotRowsLoaded: number;
      bookingRowsLoaded: number;
    }
  | { ok: false; error: string; details?: string };

function asTrimmed(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function asIntNullable(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

export function normalizeRawIntegrationSlot(
  raw: Record<string, unknown>
): WhooshAggSlotRow | null {
  const time =
    asTrimmed(raw.time, 64) ??
    asTrimmed(raw.slot_time as string | undefined, 64);
  if (!time) return null;

  const slotDate =
    asTrimmed(raw.date, 64) ??
    asTrimmed(raw.slot_date, 64) ??
    asTrimmed(raw.agenda_date, 64);

  return {
    course_id: asTrimmed(raw.course_id, 160),
    course_name: asTrimmed(raw.course_name, 400),
    slot_date: slotDate ?? undefined,
    agenda_date: slotDate ?? undefined,
    time,
    capacity: asIntNullable(raw.capacity),
    used_capacity: asIntNullable(raw.used_capacity ?? raw.used),
    type: asTrimmed(raw.type, 120),
  };
}

/** Stable bay/slot identifier for bookings + dedupe. Prefer vendor id field. */
export function whooshSlotResourceId(raw: Record<string, unknown>): string {
  const id = raw.id ?? raw.uuid ?? raw.slot_id ?? raw.agenda_slot_id;
  const s =
    id !== null && id !== undefined && String(id).trim() ? String(id).trim() : "";
  if (s) return s;
  const course = String(raw.course_id ?? raw.course_name ?? "").slice(0, 96);
  const timePart = String(raw.time ?? "").slice(0, 48);
  return `composer:${course}|${timePart}`;
}

async function fetchAgendaJsonList(
  agendaDateYmd: string,
  segment: "slots" | "bookings"
): Promise<{ ok: true; list: Record<string, unknown>[] } | { ok: false; error: string }> {
  const res = await whooshServerFetch(
    whooshIntegrationAgendaPath(agendaDateYmd, segment),
    { method: "GET" }
  );
  if (!res.ok) return { ok: false, error: `Whoosh ${segment} HTTP ${res.status}` };

  try {
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    const list = extractWhooshIntegrationList(parsed).filter(
      (r): r is Record<string, unknown> =>
        r !== null && typeof r === "object" && !Array.isArray(r)
    );
    return { ok: true, list };
  } catch {
    return { ok: false, error: `Whoosh ${segment} invalid JSON` };
  }
}

export type PreferredTimeWindowFilter = {
  hourStartInclusive: number;
  hourEndExclusive: number;
};

type WindowFilter = PreferredTimeWindowFilter | null;

/**
 * Coarse dayparts plus explicit clocks from SMS (`7pm`, `11:30 am`).
 * Clock strings used to return null, so Whoosh offered the first public slots (~11am)
 * when the customer asked for evening.
 */
export function parsePreferredTimeRange(raw: string | null | undefined): WindowFilter {
  if (!raw || !raw.trim()) return null;
  const text = raw.trim().toLowerCase();

  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text);
  if (clock?.[1] && clock[3]) {
    let hour = Number(clock[1]);
    const minute = clock[2] != null && clock[2] !== "" ? Number(clock[2]) : 0;
    const mer = clock[3].toLowerCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (mer === "pm" && hour < 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
    const start = hour + minute / 60;
    return { hourStartInclusive: start, hourEndExclusive: start + 1 };
  }

  if (text.includes("morning"))
    return { hourStartInclusive: 11, hourEndExclusive: 14 };
  if (text.includes("afternoon"))
    return { hourStartInclusive: 14, hourEndExclusive: 17 };
  if (
    text.includes("evening") ||
    text.includes("after work") ||
    text.includes("tonight") ||
    text.includes("later")
  )
    return { hourStartInclusive: 17, hourEndExclusive: 21 };
  return null;
}

function slotPassesWindow(dt: DateTime, win: WindowFilter): boolean {
  if (!win) return true;
  const local = dt.setZone("America/Los_Angeles");
  const h = local.hour + local.minute / 60;
  const lo = win.hourStartInclusive;
  const hi = win.hourEndExclusive;
  return h >= lo && h < hi;
}

function passesSimulatorCourseFilter(courseName: string | null, slotType: string | null): boolean {
  const hay = `${courseName ?? ""} ${slotType ?? ""}`.toLowerCase();
  if (hay.includes("event block") || hay.includes("reserved event")) return false;
  return true;
}

function remainingCapacity(slot: WhooshAggSlotRow): number {
  const cap = slot.capacity ?? 1;
  const used = slot.used_capacity ?? 0;
  return Math.max(0, Math.max(cap, 1) - Math.max(used, 0));
}

/**
 * Lessons use the same public simulator inventory lanes unless/until vendor tags lesson bays.
 */
function shouldSkipGenericSimulatorSlot(
  serviceType: WhooshServiceType,
  haystack: string
): boolean {
  if (serviceType !== "lesson") return false;
  /** Still skip obvious blocked labels */
  return /event block|reserved event/i.test(haystack);
}

/** Live Whoosh-backed availability lookup for SMS tooling + AI context. */
export async function getWhooshAvailability(
  params: WhooshAvailabilityParams
): Promise<WhooshAvailabilityResult> {
  const agenda_date = params.date.trim();
  if (!YMD_RE.test(agenda_date)) {
    return { ok: false, error: "invalid_date_expected_yyyy_mm_dd" };
  }

  const partySize = Math.max(1, Math.round(params.partySize));
  const durationMinutes = Math.min(
    Math.max(30, Math.round(params.durationMinutes)),
    12 * 60
  );

  if (params.serviceType === "event" && partySize > 20) {
    return { ok: false, error: "large_event_requires_human_planner" };
  }

  if (!isWhooshServerConfigured()) {
    return { ok: false, error: "whoosh_env_not_configured" };
  }

  const fetchedAtIso = new Date().toISOString();
  const window = parsePreferredTimeRange(params.preferredTimeRange);
  const facilityLabel = getWhooshAgendaFacilitySlugFromEnv();

  try {
    const [slotsFetched, bookingsFetched] = await Promise.all([
      fetchAgendaJsonList(agenda_date, "slots"),
      fetchAgendaJsonList(agenda_date, "bookings"),
    ]);

    if (!slotsFetched.ok) return { ok: false, error: slotsFetched.error };
    if (!bookingsFetched.ok) return { ok: false, error: bookingsFetched.error };

    const bookingRowsLoaded = bookingsFetched.list.length;

    const out: NormalizedWhooshAvailabilitySlot[] = [];

    for (const rawRecord of slotsFetched.list) {
      const normalized = normalizeRawIntegrationSlot(rawRecord);
      const agenda = (
        normalized?.slot_date ??
        normalized?.agenda_date ??
        agenda_date
      )?.trim();
      const timeRaw = normalized?.time;
      if (!normalized || !agenda || !timeRaw) continue;

      const hay = `${normalized.course_name ?? ""} ${normalized.type ?? ""}`;

      if (shouldSkipGenericSimulatorSlot(params.serviceType, hay)) continue;

      if (!passesSimulatorCourseFilter(normalized.course_name ?? null, normalized.type ?? null))
        continue;

      if (params.serviceType === "event" && partySize > 40) continue;

      const parsedStart = parseSlotLocalDateTime({
        agendaDateYmd:
          agenda ??
          DateTime.now().setZone("America/Los_Angeles").toFormat("yyyy-MM-dd"),
        timeRaw,
      });

      if (!parsedStart?.isValid) continue;

      if (!isSlotEligibleForSmsPublicSimulator(parsedStart)) continue;

      if (!slotPassesWindow(parsedStart, window)) continue;

      const rem = remainingCapacity(normalized);

      /** Party seats: simplistic headcount heuristic for SMS */
      const seatsNeeded = params.serviceType === "lesson" ? Math.min(partySize, 8) : partySize;

      if (rem < Math.min(Math.max(seatsNeeded, 1), 24)) continue;

      const startIso = parsedStart.toISO();
      const endDt = parsedStart.plus({ minutes: durationMinutes });
      const endIso = endDt.toISO();

      if (!startIso || !endIso) continue;

      let priceEstimate: string | null = null;
      if (params.serviceType === "lesson") {
        priceEstimate =
          partySize <= 1
            ? `Adults from $${PRIMETIME_LESSON_USD.adult_30_session}/$${PRIMETIME_LESSON_USD.adult_60_session}; Junior $${PRIMETIME_LESSON_USD.junior_60_session}`
            : "Lesson tiers per approved SMS pricing.";
      } else {
        priceEstimate = formatEstimatedSimulatorPrice({
          partySize,
          durationMinutes,
          slotStart: parsedStart,
        });
      }

      const resourceId = whooshSlotResourceId(rawRecord);

      out.push({
        startTime: startIso,
        endTime: endIso,
        bayOrResourceId: resourceId,
        resourceName:
          normalized.course_name ?? normalized.course_id ?? normalized.type ?? null,
        serviceType: params.serviceType,
        priceEstimate,
        raw: {
          ...rawRecord,
          facilitySlug: facilityLabel,
          facility_slug: facilityLabel,
          agenda_date,
        },
      });

      if (out.length >= 40) break;
    }

    out.sort((a, b) => a.startTime.localeCompare(b.startTime));

    const uniqueStarts = new Map<string, NormalizedWhooshAvailabilitySlot>();
    for (const row of out) {
      if (!uniqueStarts.has(row.startTime)) uniqueStarts.set(row.startTime, row);
      if (uniqueStarts.size >= 12) break;
    }

    return {
      ok: true,
      slots: [...uniqueStarts.values()],
      fetchedAtIso,
      agenda_date,
      slotRowsLoaded: slotsFetched.list.length,
      bookingRowsLoaded,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown_whoosh_failure";
    return { ok: false, error: "whoosh_availability_failed", details: msg };
  }
}
