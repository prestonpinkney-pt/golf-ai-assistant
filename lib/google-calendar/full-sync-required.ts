/**
 * Google Calendar incremental sync returns HTTP 410 / fullSyncRequired when
 * the stored syncToken is invalid (expiry, ACL change, long gap). Clients must
 * discard the token and perform a full sync.
 *
 * @see https://developers.google.com/workspace/calendar/api/guides/sync
 */

export function isGoogleCalendarFullSyncRequired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as {
    code?: number | string;
    status?: number;
    response?: { status?: number };
    errors?: Array<{ reason?: string }>;
    message?: string;
  };

  const statusCandidates = [
    err.response?.status,
    typeof err.status === "number" ? err.status : undefined,
    typeof err.code === "number" ? err.code : Number(err.code),
  ].filter((value): value is number => Number.isFinite(value));

  if (statusCandidates.some((status) => status === 410)) {
    return true;
  }

  if (
    Array.isArray(err.errors) &&
    err.errors.some((entry) => entry?.reason === "fullSyncRequired")
  ) {
    return true;
  }

  if (
    typeof err.message === "string" &&
    /fullSyncRequired|sync token is no longer valid/i.test(err.message)
  ) {
    return true;
  }

  return false;
}

export async function syncWithFullSyncTokenRecovery<TCalendar extends { sync_token: string | null }, TResult>(input: {
  calendar: TCalendar;
  sync: (calendar: TCalendar) => Promise<TResult>;
  clearSyncToken: () => Promise<void>;
}): Promise<TResult> {
  try {
    return await input.sync(input.calendar);
  } catch (error) {
    if (!input.calendar.sync_token || !isGoogleCalendarFullSyncRequired(error)) {
      throw error;
    }

    await input.clearSyncToken();
    return await input.sync({
      ...input.calendar,
      sync_token: null,
    });
  }
}
