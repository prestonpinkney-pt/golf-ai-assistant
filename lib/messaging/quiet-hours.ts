import { DateTime } from "luxon";

/**
 * When enabled, suppresses automated AI replies during local quiet hours (operator SMS still respects config copy).
 * Set CLOSEOS_QUIET_HOURS_ENABLED=true and window envs, or leave unset to disable.
 *
 * When quiet hours are active, outbound SMS can optionally be deferred while still allowing AI drafting:
 * set CLOSEOS_QUIET_HOURS_DEFER_OUTBOUND_SEND=false to keep the legacy "no AI during quiet hours" behavior;
 * leave unset or true to defer only immediate sends (see lib/agent/business-rules-gate.ts).
 * Deferred `pending_send` drafts are flushed by `/api/cron/flush-deferred-outbound` once the window ends.
 */
export function isInboundQuietHoursActive(): boolean {
  const enabled = (process.env.CLOSEOS_QUIET_HOURS_ENABLED || "")
    .trim()
    .toLowerCase();
  if (!["1", "true", "yes", "on"].includes(enabled)) {
    return false;
  }

  const tz =
    process.env.CLOSEOS_QUIET_HOURS_TIMEZONE?.trim() || "America/Los_Angeles";
  const startRaw = process.env.CLOSEOS_QUIET_HOURS_START?.trim() || "21:00";
  const endRaw = process.env.CLOSEOS_QUIET_HOURS_END?.trim() || "08:00";

  const now = DateTime.now().setZone(tz);
  if (!now.isValid) return false;

  const [sh, sm] = startRaw.split(":").map((n) => parseInt(n, 10) || 0);
  const [eh, em] = endRaw.split(":").map((n) => parseInt(n, 10) || 0);

  const start = now.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const end = now.set({ hour: eh, minute: em, second: 0, millisecond: 0 });

  if (start <= end) {
    return now >= start && now <= end;
  }
  return now >= start || now <= end;
}
