import { sendSentDmOutbound } from "./sentdm-outbound";

export type { MessagingProviderId } from "./provider-resolve";
export {
  getResolvedMessagingProvider,
  parseMessagingProviderId,
} from "./provider-resolve";

export type OutboundSmsInput = {
  channel: string;
  to: string;
  message: string;
  name?: string | null;
  businessName?: string | null;
  templateId?: string;
  idempotencyKey?: string | null;
};

export type OutboundSmsResult = {
  success: boolean;
  provider: string;
  external_id: string | null;
  status: string;
  raw?: unknown;
};

/** Outbound SMS — Sent.dm only. */
export async function sendOutboundSms(
  input: OutboundSmsInput
): Promise<OutboundSmsResult> {
  return sendSentDmOutbound(input);
}
