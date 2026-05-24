import "server-only";

import { DateTime } from "luxon";

import type { NormalizedWhooshAvailabilitySlot } from "@/lib/whoosh/availability";
import { whooshServerFetch } from "@/lib/whoosh/client";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_CONFIRMED_STATUS_RE =
  /^(confirmed|approved|booked|complete|completed|success)$/i;
const BOOKING_PENDING_STATUS_RE =
  /^(pending|submitted|queued|processing|received|processing_request|in_progress)$/i;

export type WhooshBookingCreateParams = {
  /** CloseOS correlation (not duplicated on integration customer object). */
  contactId: string;
  customerName: string | null;
  /** E.164 or best normalized phone — included in POST body only, never logged verbatim. */
  customerPhone: string | null;
  /** Whoosh / club member id when known (else `WHOOSH_BOOKING_GUEST_MEMBER_NUMBER` must be set). */
  contactMemberNumber?: string | null;
  selectedSlot: NormalizedWhooshAvailabilitySlot;
  partySize: number;
  durationMinutes: number;
  /**
   * `agenda_date` from the preceding `getWhooshAvailability` result (audit / mismatch diagnostics vs slot raw).
   */
  availabilityAgendaDate?: string | null;
};

/** Prefix for config error when guest member env is unset and contact has no member id. */
export const WHOOSH_BOOKING_GUEST_MEMBER_CONFIG_ERROR =
  "WHOOSH_BOOKING_GUEST_MEMBER_NUMBER missing and no contact member number available";

/** Raw slot keys examined for an agenda / schedule correlation id (presence flags only in audits). */
export const WHOOSH_RAW_AGENDA_CORRELATION_KEYS = [
  "agenda_id",
  "agendaId",
  "agenda_uuid",
  "agendaUuid",
  "schedule_id",
  "scheduleId",
  "booking_window_id",
  "bookingWindowId",
] as const;

export type WhooshRawAgendaCorrelationKey = (typeof WHOOSH_RAW_AGENDA_CORRELATION_KEYS)[number];

export type WhooshRawAgendaKeyPresence = Record<WhooshRawAgendaCorrelationKey, boolean>;

/** True per key when the raw slot has a non-empty stringifiable value (audit only). */
export function whooshSlotRawAgendaKeyPresence(raw: Record<string, unknown>): WhooshRawAgendaKeyPresence {
  const truthy = (k: string): boolean => {
    const v = raw[k];
    if (v === null || v === undefined) return false;
    const s = typeof v === "string" ? v.trim() : String(v).trim();
    return s.length > 0;
  };
  return {
    agenda_id: truthy("agenda_id"),
    agendaId: truthy("agendaId"),
    agenda_uuid: truthy("agenda_uuid"),
    agendaUuid: truthy("agendaUuid"),
    schedule_id: truthy("schedule_id"),
    scheduleId: truthy("scheduleId"),
    booking_window_id: truthy("booking_window_id"),
    bookingWindowId: truthy("bookingWindowId"),
  };
}

export function emptyWhooshRawAgendaKeyPresence(): WhooshRawAgendaKeyPresence {
  const o = {} as WhooshRawAgendaKeyPresence;
  for (const k of WHOOSH_RAW_AGENDA_CORRELATION_KEYS) o[k] = false;
  return o;
}

/**
 * First non-empty agenda correlation from raw (priority order). Always emitted on the wire/POST as **`agenda_id`**.
 */
export function resolveWhooshBookingAgendaCorrelationId(raw: Record<string, unknown>): string | null {
  for (const k of WHOOSH_RAW_AGENDA_CORRELATION_KEYS) {
    const v = raw[k];
    const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
    if (s.length > 0) return s;
  }
  return null;
}

/** Wire shape POSTed to `WHOOSH_BOOKING_POST_PATH` (e.g. `/integration/api/booking_request`). */
export type WhooshIntegrationBookingWire = {
  facility_slug: string;
  agenda_date: string;
  slot_id: string;
  /** When set, included on POST (Whoosh snake_case). Sourced from slot raw (`agenda_id`, `agendaId`, …). */
  agenda_id?: string;
  course_id?: string;
  bay_id: string;
  customer: { name: string; phone: string };
  players: number;
  start_time: string;
  duration: number;
  /** Whoosh-required (422 validation) fields — kept alongside compatibility keys above. */
  memberNumber: string;
  /** Same instant as {@link WhooshIntegrationBookingWire.start_time} — Whoosh field name. */
  dateTime: string;
  totalPlayerCount: number;
  holes: string;
  transportation: string;
  source: string;
  status: string;

  /** Set by builder for logging/persist only — omitted from POST JSON. */
  memberNumberFromContact?: boolean;
  /** Omitted from POST — how {@link WhooshIntegrationBookingWire.dateTime} was derived. */
  integrationDatetimeMode?: "raw_local" | "iso_offset";
  integrationRawSlotDate?: string | null;
  integrationRawSlotTime?: string | null;
  /** Omitted from POST — which raw agenda-correlation keys had values (for failed summary / dev). */
  integrationSlotRawAgendaKeyPresence?: WhooshRawAgendaKeyPresence;
};

export type WhooshBookingSuccess = {
  ok: true;
  outcome: "confirmed" | "pending";
  bookingId: string | null;
  requestId: string | null;
  confirmationNumber: string | null;
  startTime: string;
  endTime: string;
  raw: Record<string, unknown>;
};

/** Snapshot of audited fields read from serialized POST JSON (holes,transportation,member,...). */
export type WhooshBookingPostAuditCore = {
  transportation: unknown;
  holes: unknown;
  memberNumberPresent: boolean;
  dateTime: unknown;
  totalPlayerCount: unknown;
};

/** Fields actually serialized on POST (after `WHOOSH_BOOKING_JSON_TEMPLATE` merge); for audits when Whoosh rejects the body (e.g. enum errors). */
export type WhooshBookingAttemptedPostPayloadSummary = WhooshBookingPostAuditCore & {
  agenda_date: unknown;
  facility_slug: unknown;
  course_id: unknown;
  slot_id: unknown;
  bay_id: unknown;
  raw_date: unknown;
  raw_time: unknown;
  whoosh_booking_datetime_mode: unknown;
  /** Serialized POST body includes a non-empty `agenda_id`. */
  agenda_id_present: boolean;
  whoosh_raw_agenda_key_presence: WhooshRawAgendaKeyPresence;
};

export type WhooshBookingFailure = {
  ok: false;
  error: string;
  raw?: unknown;
  attemptedPostPayloadSummary?: WhooshBookingAttemptedPostPayloadSummary;
};

export type WhooshBookingResult = WhooshBookingSuccess | WhooshBookingFailure;

/** Env flags for booking POST (never includes secrets). */
export type WhooshBookingCreateEnvDiagnostics = {
  bookingApiEnabled: boolean;
  bookingPostPathPresent: boolean;
  whooshApiBaseUrlPresent: boolean;
  whooshApiTokenPresent: boolean;
};

export function getWhooshBookingCreateEnvDiagnostics(): WhooshBookingCreateEnvDiagnostics {
  const enabledRaw = process.env.WHOOSH_BOOKING_API_ENABLED ?? "false";
  const bookingApiEnabled =
    enabledRaw.trim().toLowerCase() === "true" ||
    enabledRaw.trim() === "1" ||
    enabledRaw.trim().toLowerCase() === "yes";
  return {
    bookingApiEnabled,
    bookingPostPathPresent: !!(process.env.WHOOSH_BOOKING_POST_PATH?.trim()),
    whooshApiBaseUrlPresent: !!(process.env.WHOOSH_API_BASE_URL?.trim()),
    whooshApiTokenPresent: !!(process.env.WHOOSH_API_TOKEN?.trim()),
  };
}

/** True when outbound code may call POST-based Whoosh booking creation. */
export function isWhooshBookingApiConfigured(): boolean {
  const e = getWhooshBookingCreateEnvDiagnostics();
  return e.bookingApiEnabled && e.bookingPostPathPresent;
}

function firstTrimmedString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const s = String(c).trim();
    if (s) return s;
  }
  return null;
}

/** Agenda date string for POST body (`YYYY-MM-DD`). */
export function resolveWhooshBookingAgendaDate(slot: NormalizedWhooshAvailabilitySlot): string {
  const fromRaw =
    typeof slot.raw?.agenda_date === "string" ? slot.raw.agenda_date.trim()
    : typeof slot.raw?.slot_date === "string" ? slot.raw.slot_date.trim()
    : typeof slot.raw?.date === "string" ? slot.raw.date.trim()
    : "";
  if (YMD.test(fromRaw)) return fromRaw;

  const dt =
    DateTime.fromISO(slot.startTime, { setZone: true }).isValid
      ? DateTime.fromISO(slot.startTime, { setZone: true })
      : DateTime.fromISO(slot.startTime);
  if (dt.isValid) return dt.setZone("America/Los_Angeles").toFormat("yyyy-MM-dd");
  return DateTime.utc().toFormat("yyyy-MM-dd");
}

/** `WHOOSH_BOOKING_DATETIME_MODE`: `raw_local` (build `YYYY-MM-DDTHH:mm:ss` from slot raw.date + raw.time) vs `iso_offset` (normalized slot.startTime ISO). Defaults to **`raw_local`**. */
export function resolveWhooshBookingDateTimeMode(): "raw_local" | "iso_offset" {
  const v = (process.env.WHOOSH_BOOKING_DATETIME_MODE ?? "raw_local").trim().toLowerCase();
  return v === "iso_offset" ? "iso_offset" : "raw_local";
}

export function normalizeWhooshRawLocalTimeFragment(time: string): string {
  const t = String(time ?? "").trim();
  if (!t) return t;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(t);
  if (!m) return t;
  const hh = m[1].padStart(2, "0");
  const mm = m[2].padStart(2, "0");
  const ss = (m[3] ?? "00").padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function resolveWhooshRawSlotCalendarDate(raw: Record<string, unknown>): string | null {
  const d = firstTrimmedString(raw.date, raw.slot_date, raw.agenda_date);
  return d !== null && YMD.test(d) ? d : null;
}

export function resolveWhooshRawSlotTimeField(raw: Record<string, unknown>): string | null {
  return firstTrimmedString(raw.time, raw.slot_time);
}

/**
 * Produce `dateTime` / `start_time` strings for booking_request.
 * Falls back from `raw_local` to ISO-with-offset slot.startTime when raw date/time are missing.
 */
export function resolveWhooshBookingWireDateTimeStrings(
  slot: NormalizedWhooshAvailabilitySlot,
  mode: "raw_local" | "iso_offset"
): {
  dateTime: string;
  start_time: string;
  integrationDatetimeMode: "raw_local" | "iso_offset";
  integrationRawSlotDate: string | null;
  integrationRawSlotTime: string | null;
} {
  const raw = slotRawRecord(slot);
  const rawDate = resolveWhooshRawSlotCalendarDate(raw);
  const rawTime = resolveWhooshRawSlotTimeField(raw);

  if (mode === "raw_local" && rawDate !== null && rawTime !== null) {
    const timeNorm = normalizeWhooshRawLocalTimeFragment(rawTime);
    const combined = `${rawDate}T${timeNorm}`;
    return {
      dateTime: combined,
      start_time: combined,
      integrationDatetimeMode: "raw_local",
      integrationRawSlotDate: rawDate,
      integrationRawSlotTime: rawTime,
    };
  }

  const iso = slot.startTime;
  return {
    dateTime: iso,
    start_time: iso,
    integrationDatetimeMode: "iso_offset",
    integrationRawSlotDate: rawDate,
    integrationRawSlotTime: rawTime,
  };
}

export function buildWhooshAvailabilityBookingDatetimeDiagnostics(opts: {
  availabilityAgendaDate?: string | null;
  slot: NormalizedWhooshAvailabilitySlot;
  wire: WhooshIntegrationBookingWire;
  /** After `WHOOSH_BOOKING_JSON_TEMPLATE` merge — compares what is actually serialized. */
  serializedDateTime: string;
}): Record<string, unknown> {
  const raw = slotRawRecord(opts.slot);
  const w = opts.wire;
  return {
    availability_agenda_date: opts.availabilityAgendaDate ?? null,
    selectedSlot_raw_date: typeof raw.date === "string" ? raw.date.trim() : null,
    selectedSlot_raw_time: resolveWhooshRawSlotTimeField(raw),
    selectedSlot_raw_slot_date: typeof raw.slot_date === "string" ? raw.slot_date.trim() : null,
    selectedSlot_raw_agenda_date:
      typeof raw.agenda_date === "string" ? raw.agenda_date.trim() : null,
    selectedSlot_startTime: opts.slot.startTime,
    selectedSlot_resourceName: opts.slot.resourceName,
    selectedSlot_course_name:
      typeof raw.course_name === "string" ? raw.course_name.trim() : null,
    facility_slug: w.facility_slug,
    course_id: w.course_id ?? null,
    bay_id: w.bay_id,
    slot_id: w.slot_id,
    wire_agenda_date: w.agenda_date,
    dateTime_sent: opts.serializedDateTime,
    whoosh_booking_datetime_mode: w.integrationDatetimeMode ?? null,
    integration_raw_slot_date: w.integrationRawSlotDate ?? null,
    integration_raw_slot_time: w.integrationRawSlotTime ?? null,
  };
}

function resolveFacilitySlug(raw: Record<string, unknown>): string {
  const a = raw.facilitySlug;
  const b = raw.facility_slug;
  const s =
    typeof a === "string" && a.trim() ? a.trim()
    : typeof b === "string" && b.trim() ? b.trim()
    : "";
  return s || "simulators";
}

function resolveCourseId(raw: Record<string, unknown>): string | null {
  return firstTrimmedString(raw.course_id);
}

/**
 * Whoosh booking `transportation` is vendor-defined (confirm accepted tokens with Whoosh support if
 * `cart`/`walking`/etc. return HTTP 422 on `/transportation`).
 *
 * Unset defaults to **`cart`** (recommended simulator default). Known shorthand tokens map via a small
 * table; anything else passes through trimmed with original casing unchanged.
 */
export function normalizeWhooshBookingTransportation(raw: string | null | undefined): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "cart";

  const key = trimmed.toLowerCase();
  /** Case-insensitive lookup only — unknown values preserve operator casing verbatim. */
  const synonyms: Record<string, string> = {
    none: "cart",
    walk: "cart",
    riding: "cart",
    ride: "cart",
    cart: "cart",
  };

  if (synonyms[key]) return synonyms[key];
  return trimmed;
}

export function summarizeWhooshBookingPostPayloadForAudit(
  payload: Record<string, unknown>
): WhooshBookingPostAuditCore {
  const mnRaw = payload.memberNumber;
  const mnStr =
    typeof mnRaw === "string" ? mnRaw.trim() : mnRaw == null ? "" : String(mnRaw).trim();
  return {
    transportation: Object.prototype.hasOwnProperty.call(payload, "transportation") ?
      payload.transportation
    : null,
    holes: Object.prototype.hasOwnProperty.call(payload, "holes") ? payload.holes : null,
    memberNumberPresent: mnStr.length > 0,
    dateTime:
      Object.prototype.hasOwnProperty.call(payload, "dateTime") ? payload.dateTime : null,
    totalPlayerCount:
      Object.prototype.hasOwnProperty.call(payload, "totalPlayerCount") ?
        payload.totalPlayerCount
      : null,
  };
}

/** Full booking failure audit incl. identifiers not always obvious from flattened POST merges. */
export function buildWhooshBookingAttemptedPostPayloadSummary(
  mergedPostPayload: Record<string, unknown>,
  wireBeforeTemplate: WhooshIntegrationBookingWire
): WhooshBookingAttemptedPostPayloadSummary {
  const core = summarizeWhooshBookingPostPayloadForAudit(mergedPostPayload);
  const has = Object.prototype.hasOwnProperty;

  const agenda_date = has.call(mergedPostPayload, "agenda_date") ?
      mergedPostPayload.agenda_date
    : wireBeforeTemplate.agenda_date;
  const facility_slug = has.call(mergedPostPayload, "facility_slug") ?
      mergedPostPayload.facility_slug
    : wireBeforeTemplate.facility_slug;
  const course_id = has.call(mergedPostPayload, "course_id") ?
      (mergedPostPayload.course_id ?? null)
    : (wireBeforeTemplate.course_id ?? null);
  const slot_id = has.call(mergedPostPayload, "slot_id") ?
      mergedPostPayload.slot_id
    : wireBeforeTemplate.slot_id;
  const bay_id = has.call(mergedPostPayload, "bay_id") ?
      mergedPostPayload.bay_id
    : wireBeforeTemplate.bay_id;

  const mergedAgendaId = has.call(mergedPostPayload, "agenda_id") ?
      mergedPostPayload.agenda_id
    : wireBeforeTemplate.agenda_id;
  const agenda_id_present =
    typeof mergedAgendaId === "string" && mergedAgendaId.trim().length > 0;

  return {
    ...core,
    agenda_date: agenda_date ?? null,
    facility_slug: facility_slug ?? null,
    course_id: course_id ?? null,
    slot_id: slot_id ?? null,
    bay_id: bay_id ?? null,
    raw_date: wireBeforeTemplate.integrationRawSlotDate ?? null,
    raw_time: wireBeforeTemplate.integrationRawSlotTime ?? null,
    whoosh_booking_datetime_mode: wireBeforeTemplate.integrationDatetimeMode ?? null,
    agenda_id_present,
    whoosh_raw_agenda_key_presence:
      wireBeforeTemplate.integrationSlotRawAgendaKeyPresence ?? emptyWhooshRawAgendaKeyPresence(),
  };
}

export function resolveWhooshBookingHolesTransportationDefaults(): {
  holes: string;
  transportation: string;
} {
  return {
    holes: (process.env.WHOOSH_BOOKING_DEFAULT_HOLES ?? "18").trim() || "18",
    transportation: normalizeWhooshBookingTransportation(
      process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION
    ),
  };
}

/**
 * Resolve Whoosh `memberNumber` from contact vs `WHOOSH_BOOKING_GUEST_MEMBER_NUMBER`.
 * No literal `"guest"` fallback — set the env explicitly for SMS guests when needed.
 */
export function resolveWhooshBookingMemberNumber(params: WhooshBookingCreateParams):
  | { ok: true; memberNumber: string; memberNumberPresent: boolean }
  | { ok: false; error: string } {
  const fromContact = firstTrimmedString(params.contactMemberNumber);
  const fromEnv = firstTrimmedString(process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER);

  if (fromContact)
    return { ok: true, memberNumber: fromContact, memberNumberPresent: true };
  if (fromEnv)
    return { ok: true, memberNumber: fromEnv, memberNumberPresent: false };
  return { ok: false, error: WHOOSH_BOOKING_GUEST_MEMBER_CONFIG_ERROR };
}

/** Drop audit-only fields; body keys match what is JSON.stringify’d on booking POST. */
export function whooshIntegrationWireToPostJson(wire: WhooshIntegrationBookingWire): Record<string, unknown> {
  const {
    memberNumberFromContact: _c,
    integrationDatetimeMode: _m,
    integrationRawSlotDate: _rd,
    integrationRawSlotTime: _rt,
    integrationSlotRawAgendaKeyPresence: _p,
    ...rest
  } = wire as WhooshIntegrationBookingWire & { memberNumberFromContact?: boolean };
  return { ...rest };
}

/** Build integration booking_request JSON from the selected normalized slot row (+ resolved member). */
export function buildWhooshIntegrationBookingWire(
  params: WhooshBookingCreateParams,
  member: { memberNumber: string; memberNumberPresent: boolean },
  opts?: { integrationStatus?: string; source?: string }
): WhooshIntegrationBookingWire {
  const raw = slotRawRecord(params.selectedSlot);
  const bay_id = params.selectedSlot.bayOrResourceId.trim();
  const slot_id =
    firstTrimmedString(raw.id, raw.slot_id, raw.uuid, raw.agenda_slot_id) ?? bay_id;
  const agenda_date = resolveWhooshBookingAgendaDate(params.selectedSlot);
  const customerName =
    typeof params.customerName === "string" && params.customerName.trim() ?
      params.customerName.trim()
    : "Guest";
  const phone = typeof params.customerPhone === "string" ? params.customerPhone.trim() : "";
  const courseResolved = resolveCourseId(raw);
  const totalPlayers = Math.max(1, Math.round(params.partySize));
  const { holes, transportation } = resolveWhooshBookingHolesTransportationDefaults();
  const mode = resolveWhooshBookingDateTimeMode();
  const dtWire = resolveWhooshBookingWireDateTimeStrings(params.selectedSlot, mode);

  const integrationSlotRawAgendaKeyPresence = whooshSlotRawAgendaKeyPresence(raw);
  const agendaCorrelationId = resolveWhooshBookingAgendaCorrelationId(raw);

  const out: WhooshIntegrationBookingWire = {
    facility_slug: resolveFacilitySlug(raw),
    agenda_date,
    slot_id,
    bay_id,
    customer: { name: customerName, phone },
    players: totalPlayers,
    start_time: dtWire.start_time,
    duration: Math.max(1, Math.round(params.durationMinutes)),
    memberNumber: member.memberNumber,
    memberNumberFromContact: member.memberNumberPresent,
    dateTime: dtWire.dateTime,
    totalPlayerCount: totalPlayers,
    holes,
    transportation,
    integrationDatetimeMode: dtWire.integrationDatetimeMode,
    integrationRawSlotDate: dtWire.integrationRawSlotDate,
    integrationRawSlotTime: dtWire.integrationRawSlotTime,
    source:
      typeof opts?.source === "string" && opts.source.trim() ? opts.source.trim() : "closeos_sms_agent",
    status:
      typeof opts?.integrationStatus === "string" && opts.integrationStatus.trim() ?
        opts.integrationStatus.trim()
      : "confirmed",
    integrationSlotRawAgendaKeyPresence,
  };
  if (courseResolved !== null && courseResolved !== "") out.course_id = courseResolved;
  if (agendaCorrelationId !== null) out.agenda_id = agendaCorrelationId;
  return out;
}

export function slotRawRecord(slot: NormalizedWhooshAvailabilitySlot): Record<string, unknown> {
  const r = slot.raw;
  if (r !== null && typeof r === "object" && !Array.isArray(r)) return r as Record<string, unknown>;
  return {};
}

/** Collect textual status-ish fields shallowly + one level deep on `booking`. */
export function extractWhooshResponseStatusHaystack(
  json: Record<string, unknown> | undefined
): string[] {
  if (!json) return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim().toLowerCase());
  };
  push(json.status);
  push(json.state);
  push(json.booking_status);
  const booking = json.booking;
  if (booking !== null && typeof booking === "object" && !Array.isArray(booking)) {
    const b = booking as Record<string, unknown>;
    push(b.status);
    push(b.state);
  }
  const data = json.data;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    push(d.status);
    push(d.state);
  }
  return out;
}

export function extractWhooshBookingAndRequestIds(json: Record<string, unknown> | undefined): {
  bookingId: string | null;
  requestId: string | null;
  genericTopId: string | null;
} {
  if (!json) return { bookingId: null, requestId: null, genericTopId: null };

  let nestedBooking: Record<string, unknown> | undefined;
  const bRaw = json.booking;
  if (bRaw !== null && typeof bRaw === "object" && !Array.isArray(bRaw)) {
    nestedBooking = bRaw as Record<string, unknown>;
  }

  const bookingId =
    firstTrimmedString(
      json.booking_id,
      json.bookingId,
      nestedBooking?.booking_id,
      nestedBooking?.bookingId
    ) ?? null;

  const requestId =
    firstTrimmedString(
      json.request_id,
      json.requestId,
      json.booking_request_id,
      json.pending_booking_id,
      nestedBooking?.request_id,
      nestedBooking?.requestId,
      nestedBooking?.booking_request_id
    ) ?? null;

  const genericTopId = firstTrimmedString(json.id, json.uuid) ?? null;

  return { bookingId, requestId, genericTopId };
}

/**
 * Decide confirmed vs pending vs error from HTTP + JSON (no secrets in return value).
 */
export function classifyWhooshBookingHttpResponse(opts: {
  httpOk: boolean;
  httpStatus: number;
  json: Record<string, unknown> | undefined;
  textBody: string;
}):
  | { kind: "failure"; error: string; raw: unknown }
  | {
      kind: "success";
      outcome: "confirmed" | "pending";
      bookingId: string | null;
      requestId: string | null;
      confirmationNumber: string | null;
    } {
  const { json, httpOk, httpStatus, textBody } = opts;

  if (!httpOk) {
    const fromErrorsArr =
      json && Array.isArray((json as { errors?: unknown }).errors) ?
        ((json as { errors: Record<string, unknown>[] }).errors)
      : [];
    const fromErrorsMsg = fromErrorsArr
      .slice(0, 4)
      .map((e) => {
        const field = typeof e.field === "string" ? e.field.trim() : "";
        const detail =
          typeof e.detail === "string" ? e.detail.trim()
          : typeof e.title === "string" ? e.title.trim()
          : "";
        if (field && detail) return `${field} ${detail}`;
        return detail || field || "";
      })
      .filter(Boolean);

    const err =
      fromErrorsMsg.length ? `Whoosh booking HTTP ${httpStatus}: ${fromErrorsMsg.join("; ")}`
      : typeof json?.error === "string" && json.error.trim() ?
        json.error.trim()
      : typeof json?.message === "string" && json.message.trim() ?
        json.message.trim()
      : textBody ?
        `Whoosh booking HTTP ${httpStatus}: ${textBody.slice(0, 520)}`
      : `Whoosh booking HTTP ${httpStatus}`;
    return { kind: "failure", error: err, raw: json ?? textBody };
  }

  const haystack = extractWhooshResponseStatusHaystack(json).join(" ");
  const hasConfirmedKeyword =
    BOOKING_CONFIRMED_STATUS_RE.test(haystack) ||
    /\bconfirmed\b/.test(haystack) ||
    /\bapproved\b/.test(haystack) ||
    /\bbooked\b/.test(haystack);

  const hasPendingKeyword =
    BOOKING_PENDING_STATUS_RE.test(haystack) || /\bpending\b/.test(haystack);

  const { bookingId: bookingIdGuess, requestId: requestIdGuess, genericTopId } =
    extractWhooshBookingAndRequestIds(json);

  const confirmationCode =
    firstTrimmedString(
      json?.confirmation_number,
      json?.confirmationNumber,
      json?.confirmation_code,
      json?.confirmationCode
    ) ?? null;

  /** Pending unless vendor language explicitly confirms booking. */
  if (hasPendingKeyword && !hasConfirmedKeyword) {
    const rid = requestIdGuess ?? genericTopId ?? bookingIdGuess;
    return {
      kind: "success",
      outcome: "pending",
      bookingId: bookingIdGuess,
      requestId: requestIdGuess ?? genericTopId,
      confirmationNumber: confirmationCode ?? rid,
    };
  }

  /** Prefer explicit vendor booking identifiers; use top-level id only when status language confirms booking. */
  if (hasConfirmedKeyword || bookingIdGuess !== null) {
    const bookingIdEffective =
      bookingIdGuess ?? (hasConfirmedKeyword ? genericTopId : null);
    return {
      kind: "success",
      outcome: "confirmed",
      bookingId: bookingIdEffective,
      requestId: requestIdGuess,
      confirmationNumber:
        confirmationCode ?? bookingIdEffective ?? genericTopId ?? requestIdGuess,
    };
  }

  if (requestIdGuess !== null) {
    const rid = requestIdGuess ?? genericTopId;
    return {
      kind: "success",
      outcome: "pending",
      bookingId: null,
      requestId: rid,
      confirmationNumber: confirmationCode ?? rid,
    };
  }

  /** HTTP OK with only a top-level id and no explicit booking field — queued request workflow. */
  if (genericTopId !== null)
    return {
      kind: "success",
      outcome: "pending",
      bookingId: null,
      requestId: genericTopId,
      confirmationNumber: confirmationCode ?? genericTopId,
    };

  return {
    kind: "failure",
    error:
      json && Object.keys(json).length ?
        `Whoosh booking response lacked booking confirmation or request identifiers (HTTP ${httpStatus}).`
      : `Whoosh booking empty OK response (HTTP ${httpStatus}).`,
    raw: json ?? textBody,
  };
}

export function summarizeWhooshBookingResponseForPersist(
  httpStatus: number,
  json: Record<string, unknown> | undefined,
  classification: Exclude<
    ReturnType<typeof classifyWhooshBookingHttpResponse>,
    { kind: "failure" }
  >
): Record<string, unknown> {
  return {
    http_status: httpStatus,
    top_level_keys: json ? Object.keys(json).slice(0, 48) : [],
    outcome: classification.outcome,
    booking_id_preview: classification.bookingId ?? null,
    request_id_preview: classification.requestId ?? null,
    status_haystack: extractWhooshResponseStatusHaystack(json).slice(0, 12),
  };
}

export function whooshIntegrationRequestPersistSummary(
  wire: WhooshIntegrationBookingWire
): Record<string, unknown> {
  /** True when a non-empty `memberNumber` is on the outbound wire (guest env or contact id). */
  const memberResolvedForPost = !!String(wire.memberNumber ?? "").trim();
  const agendaPresence = wire.integrationSlotRawAgendaKeyPresence ?? emptyWhooshRawAgendaKeyPresence();
  return {
    facility_slug: wire.facility_slug,
    agenda_date: wire.agenda_date,
    slot_id: wire.slot_id,
    agenda_id_present: !!String(wire.agenda_id ?? "").trim(),
    whoosh_raw_agenda_key_presence: agendaPresence,
    course_id: wire.course_id ?? null,
    bay_id: wire.bay_id,
    players: wire.players,
    start_time: wire.start_time,
    duration: wire.duration,
    source: wire.source,
    status: wire.status,
    customer_phone_present: !!wire.customer.phone?.trim(),
    customer_name: wire.customer.name,
    memberNumberPresent: memberResolvedForPost,
    memberNumberFromContact: !!wire.memberNumberFromContact,
    dateTime: wire.dateTime,
    totalPlayerCount: wire.totalPlayerCount,
    holes: wire.holes,
    transportation: wire.transportation,
    agenda_id: wire.agenda_id?.trim() ? wire.agenda_id.trim() : null,
  };
}

function isDevBookingLogVerbose(): boolean {
  return process.env.NODE_ENV !== "production";
}

function devLogBookingCreate(msg: string, meta?: Record<string, unknown>) {
  if (!isDevBookingLogVerbose()) return;
  if (meta && Object.keys(meta).length)
    console.info(`[whoosh-booking-create] ${msg}`, meta);
  else console.info(`[whoosh-booking-create] ${msg}`);
}

/**
 * Whoosh booking creation — POST `WHOOSH_BOOKING_POST_PATH` with integration booking_request shape.
 *
 * Configure `WHOOSH_BOOKING_POST_PATH` (relative to WHOOSH_API_BASE_URL, eg `/integration/api/booking_request`).
 *
 * Member id: set `WHOOSH_BOOKING_GUEST_MEMBER_NUMBER` when the contact has no `contactMemberNumber`,
 * or Whoosh returns a config error before POST.
 *
 * **`WHOOSH_BOOKING_DATETIME_MODE`** (default **`raw_local`**) controls `dateTime`/`start_time`:
 * `raw_local` uses agenda slot `raw.date` + `raw.time` as `YYYY-MM-DDTHH:mm:ss` (no offset); falls back to
 * ISO offset from `slot.startTime` when raw pieces are missing. `iso_offset` always uses normalized slot ISO.
 *
 * If Whoosh responds with errors like \"no agenda\" for `/dateTime` even when `raw_local` matches agenda GET,
 * stop guessing integration semantics and ask Whoosh explicitly whether **`booking_request`** supports your
 * `facility_slug` (e.g. `simulators`) and `course_id` for that **`agenda_date`** (calendar vs simulator agendas often diverge).
 *
 * Optional env (defaults in parentheses):
 * - `WHOOSH_BOOKING_DEFAULT_HOLES` (18)
 * - `WHOOSH_BOOKING_DEFAULT_TRANSPORTATION` (cart); small synonym map (`none`|`walk`|`ride`…) only; unknown values passed through verbatim
 * - `WHOOSH_BOOKING_JSON_TEMPLATE`: JSON object shallow-merged into the payload (advanced).
 */
export async function createWhooshBooking(params: WhooshBookingCreateParams): Promise<WhooshBookingResult> {
  const env = getWhooshBookingCreateEnvDiagnostics();
  const path = process.env.WHOOSH_BOOKING_POST_PATH?.trim();

  if (!env.bookingApiEnabled || !env.bookingPostPathPresent || !path) {
    return {
      ok: false,
      error:
        "Whoosh booking API is not enabled locally (WHOOSH_BOOKING_API_ENABLED/WHOOSH_BOOKING_POST_PATH).",
    };
  }

  const memberRes = resolveWhooshBookingMemberNumber(params);
  if (!memberRes.ok) {
    return { ok: false, error: memberRes.error };
  }

  const wireBody = buildWhooshIntegrationBookingWire(params, memberRes, {
    source: "closeos_sms_agent",
    integrationStatus: "confirmed",
  });

  const wirePayloadForPost = whooshIntegrationWireToPostJson(wireBody);

  {
    const rawProbe = slotRawRecord(params.selectedSlot);
    const sortedKeys = Object.keys(rawProbe).sort();
    devLogBookingCreate("POST booking_request selectedSlot.raw_probe (no values)", {
      selected_slot_raw_key_count: sortedKeys.length,
      selected_slot_raw_keys: sortedKeys,
      whoosh_raw_agenda_key_presence: whooshSlotRawAgendaKeyPresence(rawProbe),
      agenda_correlation_resolved_for_post:
        !!resolveWhooshBookingAgendaCorrelationId(rawProbe),
    });
  }

  /** Allow operators to add keys without rebuilding (merges shallowly onto integration wire). */
  const overrideRaw = process.env.WHOOSH_BOOKING_JSON_TEMPLATE?.trim();
  if (overrideRaw) {
    try {
      const parsed = JSON.parse(overrideRaw) as Record<string, unknown>;
      Object.assign(wirePayloadForPost, parsed);
    } catch {
      return { ok: false, error: "WHOOSH_BOOKING_JSON_TEMPLATE invalid JSON." };
    }
  }

  const serializedDateTime =
    typeof wirePayloadForPost.dateTime === "string" && wirePayloadForPost.dateTime.trim() ?
      wirePayloadForPost.dateTime.trim()
    : wireBody.dateTime;

  devLogBookingCreate(
    "POST booking_request availability_vs_booking_diagnostics",
    buildWhooshAvailabilityBookingDatetimeDiagnostics({
      availabilityAgendaDate: params.availabilityAgendaDate,
      slot: params.selectedSlot,
      wire: wireBody,
      serializedDateTime,
    }),
  );

  devLogBookingCreate("POST booking_request (integration wire → JSON body)", {
    path,
    payload_keys: Object.keys(wirePayloadForPost),
    selected_slot_id: wireBody.slot_id,
    course_id: wireBody.course_id,
    facility_slug: wireBody.facility_slug,
    requested_status: wireBody.status,
    memberNumberPresent: !!String(wireBody.memberNumber ?? "").trim(),
    memberNumberFromContact: !!wireBody.memberNumberFromContact,
    dateTime: serializedDateTime,
    totalPlayerCount: wireBody.totalPlayerCount,
    holes: wireBody.holes,
    transportation: wireBody.transportation,
  });

  try {
    const res = await whooshServerFetch(path, {
      method: "POST",
      body: JSON.stringify(wirePayloadForPost),
    });

    const text = await res.text();
    let json: Record<string, unknown> | undefined;
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = undefined;
      }
    }

    const summaryBody =
      json ?
        (() => {
          const extracted = extractWhooshBookingAndRequestIds(json);
          return {
            keys: Object.keys(json!).slice(0, 40),
            status_hints: extractWhooshResponseStatusHaystack(json).slice(0, 6),
            has_booking_or_request_ids: !!(
              extracted.bookingId ||
              extracted.requestId ||
              extracted.genericTopId
            ),
          };
        })()
      : { unparsed_preview_len: Math.min(text.length, 240) };

    devLogBookingCreate("booking_request response", {
      http_status: res.status,
      body_summary: summaryBody,
    });

    const verdict = classifyWhooshBookingHttpResponse({
      httpOk: res.ok,
      httpStatus: res.status,
      json,
      textBody: text,
    });

    if (verdict.kind === "failure") {
      const attemptedPostPayloadSummary = buildWhooshBookingAttemptedPostPayloadSummary(
        wirePayloadForPost,
        wireBody,
      );
      devLogBookingCreate("booking_request failed_payload_summary", attemptedPostPayloadSummary);
      return {
        ok: false,
        error: verdict.error,
        raw: verdict.raw,
        attemptedPostPayloadSummary,
      };
    }

    const responseSummaryForRaw = summarizeWhooshBookingResponseForPersist(res.status, json, verdict);

    return {
      ok: true,
      outcome: verdict.outcome,
      bookingId: verdict.bookingId,
      requestId: verdict.requestId,
      confirmationNumber: verdict.confirmationNumber,
      startTime: params.selectedSlot.startTime,
      endTime: params.selectedSlot.endTime,
      raw:
        json != null && typeof json === "object" && !Array.isArray(json) ?
          {
            ...(json as Record<string, unknown>),
            closeos_whoosh_audit: {
              integration_request_summary: whooshIntegrationRequestPersistSummary(wireBody),
              integration_response_summary: responseSummaryForRaw,
            },
          }
        : json != null ?
          {
            non_object_body: true,
            closeos_whoosh_audit: {
              integration_request_summary: whooshIntegrationRequestPersistSummary(wireBody),
              integration_response_summary: responseSummaryForRaw,
            },
          }
        : {
            empty_body: true,
            closeos_whoosh_audit: {
              integration_request_summary: whooshIntegrationRequestPersistSummary(wireBody),
              integration_response_summary: responseSummaryForRaw,
            },
          },
    };
  } catch (e: unknown) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "booking_request_failed",
      attemptedPostPayloadSummary: buildWhooshBookingAttemptedPostPayloadSummary(
        wirePayloadForPost,
        wireBody,
      ),
    };
  }
}
