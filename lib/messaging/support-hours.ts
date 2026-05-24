import { DateTime } from "luxon";

/**
 * When timezone or hours are missing, treat as "always within hours" so HELP uses live response.
 */
export function isWithinConfiguredSupportHours(input: {
  timezone: string | null;
  weekdays: number[] | null;
  openLocal: string | null;
  closeLocal: string | null;
}): boolean {
  const tz = input.timezone?.trim();
  if (!tz) return true;

  const weekdays = input.weekdays;
  if (!weekdays?.length) return true;

  const openRaw = input.openLocal?.trim();
  const closeRaw = input.closeLocal?.trim();
  if (!openRaw || !closeRaw) return true;

  const now = DateTime.now().setZone(tz);
  if (!now.isValid) return true;

  const weekday = now.weekday;
  if (!weekdays.includes(weekday)) return false;

  const [openH, openM] = openRaw.split(":").map((v) => Number.parseInt(v, 10));
  const [closeH, closeM] = closeRaw.split(":").map((v) => Number.parseInt(v, 10));
  if (
    !Number.isFinite(openH) ||
    !Number.isFinite(closeH) ||
    !Number.isFinite(openM) ||
    !Number.isFinite(closeM)
  ) {
    return true;
  }

  const open = now.set({ hour: openH, minute: openM, second: 0, millisecond: 0 });
  const close = now.set({ hour: closeH, minute: closeM, second: 0, millisecond: 0 });
  if (!open.isValid || !close.isValid) return true;

  if (close <= open) {
    return now >= open || now <= close;
  }
  return now >= open && now <= close;
}
