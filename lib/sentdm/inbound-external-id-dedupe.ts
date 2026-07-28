/**
 * Sent.dm inbound retries reuse the provider message id as `messages.external_id`.
 * An early short-circuit on "inbound row exists" drops AI/booking/compliance work when
 * the prior attempt died after insert but before an outbound reply was persisted.
 */

export function outboundLinkedToInboundMessage(input: {
  inboundMessageId: string;
  outboundMessages: Array<{ metadata?: unknown }>;
}): boolean {
  const inboundId = input.inboundMessageId.trim();
  if (!inboundId) return false;

  return input.outboundMessages.some((row) => {
    const meta = row.metadata;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
    const linked = (meta as Record<string, unknown>).inbound_message_id;
    if (linked == null) return false;
    return String(linked) === inboundId;
  });
}
