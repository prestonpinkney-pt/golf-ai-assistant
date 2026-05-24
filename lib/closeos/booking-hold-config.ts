import "server-only";

function trimEnvTruthy(raw: string | undefined): "unset" | "true" | "false" | "unknown" {
  if (raw === undefined || raw === null) return "unset";
  const v = String(raw).trim().toLowerCase();
  if (!v.length) return "unset";
  if (["0", "false", "no", "off"].includes(v)) return "false";
  if (["1", "true", "yes", "on"].includes(v)) return "true";
  return "unknown";
}

/** When true (default), simulator guests resolved via env guest MN get a Square hold before Whoosh POST. */
export function isCloseOsNonMemberSimulatorPaymentHoldEnabled(): boolean {
  const raw = trimEnvTruthy(process.env.CLOSEOS_PAYMENT_REQUIRED_FOR_NON_MEMBERS);
  if (raw === "unset") return true;
  if (raw === "false") return false;
  return true;
}

export function closeOsSimulatorHoldExpirationMinutes(): number {
  const n = Number.parseInt(process.env.CLOSEOS_BOOKING_HOLD_MINUTES ?? "10", 10);
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(n, 1), 1440);
}

/**
 * When Whoosh rejects the booking POST after Square payment clears, CloseOS still marks the row
 * `paid_confirmed` and notifies the guest (SMS) while ops reconcile Whoosh asynchronously.
 *
 * Recoverable **`agenda_not_found`**-style faults always prefer this softer path independently of env.
 */
export function isCloseOsAutonomousBookingConfirmOnPayment(): boolean {
  const raw = trimEnvTruthy(process.env.CLOSEOS_AUTONOMOUS_BOOKING_CONFIRM_ON_PAYMENT);
  return raw === "true";
}
