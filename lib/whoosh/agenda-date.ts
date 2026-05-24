import "server-only";

import { DateTime } from "luxon";

/** Primary: IANA zone for interpreting “today” on agenda routes. */
export const WHOOSH_AGENDA_LOCAL_TIMEZONE_ENV = "WHOOSH_AGENDA_LOCAL_TIMEZONE" as const;

export type AgendaDateDefaultTimezoneSource =
  | typeof WHOOSH_AGENDA_LOCAL_TIMEZONE_ENV
  | "CLOSEOS_BUSINESS_TIMEZONE"
  /** No env TZ set — Primetime Golf default (America/Los_Angeles calendar “today”). */
  | "PRIMETIME_DEFAULT_LA";

/**
 * TZ used when `date` query is omitted. Order:
 * WHOOSH_AGENDA_LOCAL_TIMEZONE → CLOSEOS_BUSINESS_TIMEZONE → America/Los_Angeles.
 */
export function resolveWhooshAgendaDefaultTimezone(): {
  ianaTimezone: string;
  sourceEnv: AgendaDateDefaultTimezoneSource;
} {
  const whooshTz =
    process.env[WHOOSH_AGENDA_LOCAL_TIMEZONE_ENV]?.trim() ?? "";
  if (whooshTz) {
    return { ianaTimezone: whooshTz, sourceEnv: WHOOSH_AGENDA_LOCAL_TIMEZONE_ENV };
  }
  const businessTz = process.env.CLOSEOS_BUSINESS_TIMEZONE?.trim() ?? "";
  if (businessTz) {
    return { ianaTimezone: businessTz, sourceEnv: "CLOSEOS_BUSINESS_TIMEZONE" };
  }
  return { ianaTimezone: "America/Los_Angeles", sourceEnv: "PRIMETIME_DEFAULT_LA" };
}

/**
 * Calendar `YYYY-MM-DD` for “today” using {@link resolveWhooshAgendaDefaultTimezone}.
 */
export function whooshAgendaDateTodayInConfiguredTimezone(): {
  isoDate: string;
  ianaTimezone: string;
  sourceEnv: AgendaDateDefaultTimezoneSource;
  invalidTimezoneUsedUtc: boolean;
} {
  const { ianaTimezone, sourceEnv } = resolveWhooshAgendaDefaultTimezone();

  const localNow = DateTime.now().setZone(ianaTimezone);
  if (!localNow.isValid) {
    const laNow = DateTime.now().setZone("America/Los_Angeles");
    if (laNow.isValid) {
      return {
        isoDate: laNow.toISODate()!,
        ianaTimezone: "America/Los_Angeles",
        sourceEnv,
        invalidTimezoneUsedUtc: true,
      };
    }
    return {
      isoDate: DateTime.utc().toISODate()!,
      ianaTimezone: "UTC",
      sourceEnv,
      invalidTimezoneUsedUtc: true,
    };
  }

  return {
    isoDate: localNow.toISODate()!,
    ianaTimezone,
    sourceEnv,
    invalidTimezoneUsedUtc: false,
  };
}

/** Validate explicit `YYYY-MM-DD` — calendar check uses UTC midday to avoid ambiguity. */
function isValidCalendarYmd(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const dt = DateTime.fromISO(dateStr, { zone: "utc" });
  return dt.isValid && dt.toISODate() === dateStr;
}

export type ParseWhooshAgendaDateResult =
  | {
      ok: true;
      date: string;
      /** Present only when no `date` query was supplied. */
      defaultFromTimezone?: {
        ianaTimezone: string;
        sourceEnv: AgendaDateDefaultTimezoneSource;
        /** True when configured IANA TZ was invalid; fell back to UTC `YYYY-MM-DD`. */
        fellBackToUtcDueToInvalidZone: boolean;
      };
    }
  | { ok: false; message: string };

/**
 * Parses optional `date` query (`YYYY-MM-DD`). If omitted, uses business/facility
 * local “today” (see WHOOSH_AGENDA_LOCAL_TIMEZONE / CLOSEOS_BUSINESS_TIMEZONE).
 */
export function parseWhooshAgendaDateParam(
  raw: string | null
): ParseWhooshAgendaDateResult {
  const trimmed = raw?.trim();
  if (!trimmed) {
    const def = whooshAgendaDateTodayInConfiguredTimezone();
    return {
      ok: true,
      date: def.isoDate,
      defaultFromTimezone: {
        ianaTimezone: def.ianaTimezone,
        sourceEnv: def.sourceEnv,
        fellBackToUtcDueToInvalidZone: def.invalidTimezoneUsedUtc,
      },
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return {
      ok: false,
      message: "Invalid date query parameter (use YYYY-MM-DD).",
    };
  }

  if (!isValidCalendarYmd(trimmed)) {
    return { ok: false, message: "Invalid calendar date." };
  }

  return { ok: true, date: trimmed };
}

/** Attach to agenda route JSON — never includes secrets. */
export function whooshAgendaDateQueryReporting(
  resolved: Extract<ParseWhooshAgendaDateResult, { ok: true }>
): {
  agendaDateProvidedByQuery: boolean;
  agendaDateDefaultTimezone?: string;
  agendaDateTimezoneSourceEnv?: AgendaDateDefaultTimezoneSource;
  agendaDateTimezoneInvalidFallbackUtc?: boolean;
  agendaDateDefaultTimezoneNote?: string;
} {
  if (!resolved.defaultFromTimezone) {
    return { agendaDateProvidedByQuery: true };
  }
  const d = resolved.defaultFromTimezone;
  const base = {
    agendaDateProvidedByQuery: false as const,
    agendaDateDefaultTimezone: d.ianaTimezone,
    agendaDateTimezoneSourceEnv: d.sourceEnv,
    ...(d.fellBackToUtcDueToInvalidZone && d.ianaTimezone === "UTC"
      ? { agendaDateTimezoneInvalidFallbackUtc: true as const }
      : {}),
  };
  if (d.fellBackToUtcDueToInvalidZone) {
    return {
      ...base,
      agendaDateDefaultTimezoneNote:
        d.ianaTimezone === "UTC"
          ? `Time zone fallback exhausted — using UTC calendar "today"; fix WHOOSH_AGENDA_LOCAL_TIMEZONE / CLOSEOS_BUSINESS_TIMEZONE.`
          : `Configured time zone appeared invalid — using ${d.ianaTimezone} temporarily for agenda "today".`,
    };
  }
  if (d.sourceEnv === "PRIMETIME_DEFAULT_LA") {
    return {
      ...base,
      agendaDateDefaultTimezoneNote:
        `Primetime agenda “today”: ${d.ianaTimezone}. Set WHOOSH_AGENDA_LOCAL_TIMEZONE or CLOSEOS_BUSINESS_TIMEZONE to override.`,
    };
  }
  return base;
}
