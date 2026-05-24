/**
 * Sent.dm outbound API — delegates to `@/lib/sentdm/send-message`.
 */

import {
  sendSentDmMessage,
  type SentDmChannel,
  type SentDmSendMessageResult,
} from "@/lib/sentdm/send-message";

export type SentDmSendMessageInput = {
  channel: string;
  to: string;
  message: string;
  name?: string | null;
  businessName?: string | null;
  templateId?: string;
  /** Passed through as Sent.dm Idempotency-Key when using direct_text mode. */
  idempotencyKey?: string | null;
};

export type { SentDmSendMessageResult };

export async function sendSentDmOutbound(
  input: SentDmSendMessageInput
): Promise<SentDmSendMessageResult> {
  const lowered = (input.channel || "sms").toLowerCase();
  const channel: SentDmChannel = lowered === "rcs" ? "rcs" : "sms";
  return sendSentDmMessage({
    to: input.to,
    message: input.message,
    channel,
    name: input.name,
    businessName: input.businessName,
    templateId: input.templateId,
    idempotencyKey: input.idempotencyKey,
  });
}
