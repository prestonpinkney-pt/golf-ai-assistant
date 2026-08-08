/**
 * Google Calendar incremental sync with showDeleted=true often returns cancelled
 * events with missing start/end, or placeholder times around year 2000. Those must
 * still flip an already-synced booking_reservations row to cancelled.
 */

export type CancelledReservationWrite =
  | { kind: "skip"; reason: "missing_external_id" | "no_existing_and_no_usable_times" }
  | { kind: "status_only"; externalId: string }
  | {
      kind: "full_upsert";
      externalId: string;
      startsAt: string;
      endsAt: string;
    };

/** Google sometimes returns sentinel 2000-01-01 times on sparse cancelled payloads. */
export function isUnusableCancelledEventTime(value: string | null | undefined): boolean {
  if (!value || !value.trim()) return true;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return true;
  return new Date(ms).getUTCFullYear() <= 2000;
}

export function resolveCancelledReservationWrite(input: {
  externalId: string | null | undefined;
  startsAt: string | null | undefined;
  endsAt: string | null | undefined;
  hasExistingReservation: boolean;
}): CancelledReservationWrite {
  const externalId =
    typeof input.externalId === "string" ? input.externalId.trim() : "";
  if (!externalId) {
    return { kind: "skip", reason: "missing_external_id" };
  }

  // Prefer status-only updates so placeholder/missing times cannot wipe real slots.
  if (input.hasExistingReservation) {
    return { kind: "status_only", externalId };
  }

  const startsAt =
    typeof input.startsAt === "string" ? input.startsAt.trim() : "";
  const endsAt = typeof input.endsAt === "string" ? input.endsAt.trim() : "";

  if (
    !startsAt ||
    !endsAt ||
    isUnusableCancelledEventTime(startsAt) ||
    isUnusableCancelledEventTime(endsAt)
  ) {
    return { kind: "skip", reason: "no_existing_and_no_usable_times" };
  }

  return {
    kind: "full_upsert",
    externalId,
    startsAt,
    endsAt,
  };
}
