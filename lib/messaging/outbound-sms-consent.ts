import { getContactSendBlockedReason } from "@/lib/messaging/cooling-off";

/**
 * Shared fail-closed consent gate for ad-hoc / cron SMS paths that do not
 * go through the conversation reply or campaign send policy engines.
 */
export function resolveOutboundSmsConsentGate(input: {
  contact: {
    sms_opt_out?: boolean | null;
    cooling_off_until?: string | null;
  } | null;
  lookupError: { message?: string } | null;
}):
  | { allowed: true }
  | { allowed: false; status: 403 | 503; error: string } {
  if (input.lookupError) {
    return {
      allowed: false,
      status: 503,
      error:
        "Unable to verify contact SMS consent; send blocked until consent can be checked.",
    };
  }
  if (!input.contact) {
    return { allowed: true };
  }
  const blocked = getContactSendBlockedReason({
    sms_opt_out: Boolean(input.contact.sms_opt_out),
    cooling_off_until: input.contact.cooling_off_until ?? null,
  });
  if (blocked) {
    return { allowed: false, status: 403, error: blocked };
  }
  return { allowed: true };
}
