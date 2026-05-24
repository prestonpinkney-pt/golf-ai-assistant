/**
 * Pure rules: only true customer SMS should enter the conversational inbound loop.
 * Final classification uses Sent.dm GET /v3/messages/{id} (direction + status + phones).
 */

import { normalizePhone } from "@/lib/messaging/phone";
import { firstString } from "@/lib/messaging/webhook-payload";

export const OUTBOUND_TEMPLATE_WRAPPER_PREFIXES = [
  "Primetime:",
  "Message:",
] as const;

export type InboundLookupFields = {
  /** Uppercase recommended; compared case-insensitively to INBOUND / OUTBOUND */
  direction: string | null;
  /** Raw API status e.g. RECEIVED, DELIVERED — compared case-insensitively */
  statusRaw: string | null;
  from: string | null;
  to: string | null;
};

/**
 * True if this is our branded SMS wrapper (AI replies), used only with provider-id guard.
 */
export function textMatchesOurTemplateWrapperPrefix(text: string): boolean {
  const t = text.trimStart();
  for (const p of OUTBOUND_TEMPLATE_WRAPPER_PREFIXES) {
    if (t.startsWith(p)) return true;
  }
  return false;
}

/**
 * After a successful message lookup, decide if we should run the customer inbound pipeline.
 * Requires direction INBOUND and status RECEIVED (Sent.dm uppercase conventions).
 */
export function evaluateCustomerInboundEligibility(
  lookup: InboundLookupFields,
  envelope: Record<string, unknown>
): { allow: true } | { allow: false; reason: string } {
  const dir = lookup.direction?.trim().toUpperCase() ?? "";
  const st = lookup.statusRaw?.trim().toUpperCase() ?? "";

  if (dir === "OUTBOUND") {
    return { allow: false, reason: "direction_outbound" };
  }

  if (dir !== "INBOUND") {
    return {
      allow: false,
      reason: dir ? `direction_${dir.toLowerCase()}` : "direction_missing",
    };
  }

  if (st !== "RECEIVED") {
    return {
      allow: false,
      reason: st ? `status_${st.toLowerCase()}` : "status_missing",
    };
  }

  const envIn =
    normalizePhone(
      firstString(envelope, [
        "payload.inbound_number",
        "payload.inboundNumber",
        "inbound_number",
        "inboundNumber",
      ]) ?? null
    );
  const apiFrom = normalizePhone(lookup.from);

  if (envIn?.length && apiFrom?.length && envIn !== apiFrom) {
    return { allow: false, reason: "inbound_phone_mismatch" };
  }

  return { allow: true };
}
