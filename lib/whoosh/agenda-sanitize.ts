import "server-only";

/** Non-PII slot / tee-time style fields — allowlist only. */
export const WHOOSH_SAFE_SLOT_FIELDS = new Set([
  "id",
  "uuid",
  "external_id",
  "slot_id",
  "agenda_slot_id",
  "tee_id",
  "agenda_id",
  "course_id",
  "bay_id",
  "resource_id",
  "start_time",
  "end_time",
  "begins_at",
  "ends_at",
  "starts_at",
  "duration",
  "duration_minutes",
  "capacity",
  "max_capacity",
  "remaining_spots",
  "available",
  "is_available",
  "status",
  "label",
]);

/** Booking metadata without guest / contact fields — allowlist only. */
export const WHOOSH_SAFE_BOOKING_FIELDS = new Set([
  "id",
  "uuid",
  "booking_id",
  "external_booking_id",
  "agenda_id",
  "slot_id",
  "agenda_slot_id",
  "status",
  "state",
  "start_time",
  "end_time",
  "begins_at",
  "ends_at",
  "starts_at",
  "party_size",
  "player_count",
  "group_size",
  "players",
  "cancelled_at",
  "confirmed",
  "booking_type_id",
]);

const LIST_KEYS = ["slots", "bookings", "data", "items", "results", "records"];

export function extractWhooshIntegrationList(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const root = parsed as Record<string, unknown>;
  for (const key of LIST_KEYS) {
    const v = root[key];
    if (Array.isArray(v)) {
      return v;
    }
  }
  return [];
}

function clampString(value: string, max: number): string {
  const t = value.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function pickWhooshSanitizedScalars(
  source: Record<string, unknown>,
  allow: ReadonlySet<string>,
  maxStringLen = 160
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of allow) {
    if (!(key in source)) continue;
    const v = source[key];
    if (v === null) {
      out[key] = null;
      continue;
    }
    if (typeof v === "boolean" || typeof v === "number") {
      out[key] = v;
      continue;
    }
    if (typeof v === "string") {
      out[key] = clampString(v, maxStringLen);
    }
  }
  return out;
}

export function collectUnknownTopLevelKeys(
  rows: unknown[],
  allow: ReadonlySet<string>,
  scanRows: number,
  cap: number
): string[] {
  const found = new Set<string>();
  const limit = Math.min(rows.length, scanRows);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (!allow.has(key)) {
        found.add(key);
      }
      if (found.size >= cap) {
        return [...found].sort();
      }
    }
  }
  return [...found].sort();
}

export type SanitizedAgendaListResult = {
  count: number;
  sample: Record<string, string | number | boolean | null>[];
  unknownTopLevelKeys: string[];
};

export function sanitizeWhooshAgendaList(
  rows: unknown[],
  allow: ReadonlySet<string>,
  sampleSize: number
): SanitizedAgendaListResult {
  const objects = rows.filter(
    (r): r is Record<string, unknown> =>
      r !== null && typeof r === "object" && !Array.isArray(r)
  );

  const sample: Record<string, string | number | boolean | null>[] = [];
  for (let i = 0; i < Math.min(objects.length, sampleSize); i++) {
    sample.push(pickWhooshSanitizedScalars(objects[i], allow));
  }

  return {
    count: rows.length,
    sample,
    unknownTopLevelKeys: collectUnknownTopLevelKeys(rows, allow, 15, 40),
  };
}
