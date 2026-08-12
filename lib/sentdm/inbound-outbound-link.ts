/**
 * Helpers for linking outbound reply rows to an inbound message via
 * `metadata.inbound_message_id`, and deciding whether a prior attempt is
 * complete vs needs a provider-send retry.
 */

export type LinkedOutboundCandidate = {
  id: unknown;
  status?: unknown;
  delivery_status?: unknown;
  message_text?: unknown;
  body?: unknown;
  channel?: unknown;
  contact_phone?: unknown;
  metadata?: unknown;
};

const TERMINAL_SENT_STATUSES = new Set([
  "queued",
  "sent",
  "delivered",
  "sending",
  "accepted",
  "submitted",
]);

const RETRYABLE_STATUSES = new Set([
  "failed",
  "pending_send",
  "needs_human",
  "not_sent",
]);

export function outboundLinksToInbound(
  outbound: LinkedOutboundCandidate,
  inboundId: string
): boolean {
  const meta = outbound.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  const linked = (meta as Record<string, unknown>).inbound_message_id;
  if (linked == null) return false;
  return String(linked) === inboundId;
}

export function findOutboundLinkedToInbound(
  outbounds: LinkedOutboundCandidate[],
  inboundId: string
): LinkedOutboundCandidate | null {
  for (const row of outbounds) {
    if (outboundLinksToInbound(row, inboundId)) return row;
  }
  return null;
}

/** True when an outbound already indicates provider acceptance / delivery. */
export function linkedOutboundAlreadySent(
  outbound: LinkedOutboundCandidate
): boolean {
  const status = String(outbound.status ?? "").toLowerCase();
  const delivery = String(outbound.delivery_status ?? "").toLowerCase();
  if (TERMINAL_SENT_STATUSES.has(status)) return true;
  if (TERMINAL_SENT_STATUSES.has(delivery)) return true;
  return false;
}

/**
 * True when a linked outbound exists but provider send never succeeded —
 * webhook retries must resend rather than short-circuit as duplicate.
 */
export function linkedOutboundNeedsProviderResend(
  outbound: LinkedOutboundCandidate
): boolean {
  if (linkedOutboundAlreadySent(outbound)) return false;
  const status = String(outbound.status ?? "").toLowerCase();
  const delivery = String(outbound.delivery_status ?? "").toLowerCase();
  return (
    RETRYABLE_STATUSES.has(status) ||
    RETRYABLE_STATUSES.has(delivery) ||
    status === "" ||
    delivery === "not_sent"
  );
}

export function readOutboundSmsBody(
  outbound: LinkedOutboundCandidate
): string | null {
  if (typeof outbound.message_text === "string" && outbound.message_text.trim()) {
    return outbound.message_text.trim();
  }
  if (typeof outbound.body === "string" && outbound.body.trim()) {
    return outbound.body.trim();
  }
  return null;
}
