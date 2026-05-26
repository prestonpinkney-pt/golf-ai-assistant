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
  normalizeRawIntegrationSlot,
  whooshSlotResourceId,
} from "@/lib/whoosh/availability";
import {
  parseSlotLocalDateTime,
  type WhooshAggSlotRow,
} from "@/lib/whoosh/opportunities";
import { isSlotEligibleForSmsPublicSimulator } from "@/lib/primetime/pricing";
import type {
  GetWhooshAvailabilityInput,
  GetWhooshAvailabilityResult,
  WhooshAvailabilityWindow,
  WhooshResourceType,
  WhooshResourceTypeFilter,
} from "@/lib/whoosh/types";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function getWhooshTimezone(): string {
  return process.env.WHOOSH_TIMEZONE?.trim() || "America/Los_Angeles";
}

function classifyResourceType(
  courseName: string | null,
  slotType: string | null
): WhooshResourceType {
  const hay = `${courseName ?? ""} ${slotType ?? ""}`.toLowerCase();
  if (hay.includes("lesson") || hay.includes("instructor")) return "lesson";
  if (hay.includes("simulator") || hay.includes("sim bay") || hay.includes("simulator bay"))
    return "simulator";
  if (hay.includes("bay") || hay.includes("lane")) return "bay";
  return "unknown";
}

function matchesResourceFilter(
  resourceType: WhooshResourceType,
  filter: WhooshResourceTypeFilter
): boolean {
  if (filter === "all") return true;
  if (filter === "simulator") return resourceType === "simulator" || resourceType === "bay";
  if (filter === "bay") return resourceType === "bay" || resourceType === "simulator";
  if (filter === "lesson") return resourceType === "lesson";
  return true;
}

function remainingCapacity(slot: WhooshAggSlotRow): number {
  const cap = slot.capacity ?? 1;
  const used = slot.used_capacity ?? 0;
  return Math.max(0, Math.max(cap, 1) - Math.max(used, 0));
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const tz = getWhooshTimezone();
  let cursor = DateTime.fromISO(startDate, { zone: tz }).startOf("day");
  const end = DateTime.fromISO(endDate, { zone: tz }).startOf("day");
  const out: string[] = [];
  while (cursor <= end && out.length < 21) {
    out.push(cursor.toFormat("yyyy-MM-dd"));
    cursor = cursor.plus({ days: 1 });
  }
  return out;
}

async function fetchAgendaSlots(agendaDate: string): Promise<
  | { ok: true; list: Record<string, unknown>[] }
  | { ok: false; error: string }
> {
  const res = await whooshServerFetch(
    whooshIntegrationAgendaPath(agendaDate, "slots"),
    { method: "GET" }
  );
  if (!res.ok) return { ok: false, error: `Whoosh slots HTTP ${res.status}` };
  try {
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    const list = extractWhooshIntegrationList(parsed).filter(
      (r): r is Record<string, unknown> =>
        r !== null && typeof r === "object" && !Array.isArray(r)
    );
    return { ok: true, list };
  } catch {
    return { ok: false, error: "Whoosh slots invalid JSON" };
  }
}

function slotToWindow(
  raw: Record<string, unknown>,
  normalized: WhooshAggSlotRow,
  agendaDate: string,
  timezone: string,
  durationMinutes: number
): WhooshAvailabilityWindow | null {
  const timeRaw = normalized.time;
  if (!timeRaw) return null;

  const parsedStart = parseSlotLocalDateTime({ agendaDateYmd: agendaDate, timeRaw });
  if (!parsedStart?.isValid) return null;

  if (!isSlotEligibleForSmsPublicSimulator(parsedStart) && remainingCapacity(normalized) <= 0) {
    return null;
  }

  const rem = remainingCapacity(normalized);
  const bookable = rem > 0;
  if (!bookable) return null;

  const resourceType = classifyResourceType(
    normalized.course_name ?? null,
    normalized.type ?? null
  );
  const startIso = parsedStart.toISO()!;
  const endIso = parsedStart.plus({ minutes: durationMinutes }).toISO()!;
  const resourceId = whooshSlotResourceId(raw);

  return {
    id: `${agendaDate}:${resourceId}:${timeRaw}`,
    source: "whoosh",
    startsAt: startIso,
    endsAt: endIso,
    timezone,
    resourceId,
    resourceName:
      normalized.course_name ?? normalized.course_id ?? normalized.type ?? null,
    resourceType,
    bookable: true,
    capacity: normalized.capacity ?? null,
    raw,
  };
}

/**
 * Range-based Whoosh availability for campaign + sync flows.
 * Server-only — never call from the browser.
 */
export async function getWhooshAvailability(
  input: GetWhooshAvailabilityInput
): Promise<GetWhooshAvailabilityResult> {
  const startDate = input.startDate.trim();
  const endDate = input.endDate.trim();
  const resourceType = input.resourceType ?? "all";
  const timezone = getWhooshTimezone();

  if (!YMD_RE.test(startDate) || !YMD_RE.test(endDate)) {
    return { ok: false, error: "invalid_date_range_expected_yyyy_mm_dd" };
  }

  if (!isWhooshServerConfigured()) {
    return { ok: false, error: "whoosh_env_not_configured" };
  }

  void input.facilityId;
  void getWhooshAgendaFacilitySlugFromEnv();

  const fetchedAtIso = new Date().toISOString();
  const dates = enumerateDates(startDate, endDate);
  const windows: WhooshAvailabilityWindow[] = [];
  const durationMinutes = 60;

  try {
    for (const agendaDate of dates) {
      const fetched = await fetchAgendaSlots(agendaDate);
      if (!fetched.ok) {
        return { ok: false, error: fetched.error, details: agendaDate };
      }

      for (const raw of fetched.list) {
        const normalized = normalizeRawIntegrationSlot(raw);
        if (!normalized) continue;
        const window = slotToWindow(raw, normalized, agendaDate, timezone, durationMinutes);
        if (!window) continue;
        if (!matchesResourceFilter(window.resourceType, resourceType)) continue;
        windows.push(window);
      }
    }

    windows.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

    return { ok: true, windows, fetchedAtIso };
  } catch (e: unknown) {
    return {
      ok: false,
      error: "whoosh_availability_failed",
      details: e instanceof Error ? e.message : "unknown",
    };
  }
}
