export type SentChannel = "rcs" | "sms";

export type SendSentMessageInput = {
  to: string;
  body: string;
  channel?: SentChannel;
};

export type SendSentMessageResult = {
  provider: "sent";
  providerMessageId: string | null;
  status: string;
  raw: unknown;
};

const SENT_API_URL = "https://api.sent.dm/v3/messages";

function getSentApiKey() {
  const apiKey = process.env.SENT_API_KEY;
  if (!apiKey) {
    throw new Error("Missing SENT_API_KEY");
  }
  return apiKey;
}

function assertValidMessageInput(input: SendSentMessageInput) {
  const to = input.to.trim();
  const body = input.body.trim();
  const channel = input.channel ?? "rcs";

  if (!/^\+[1-9]\d{7,14}$/.test(to)) {
    throw new Error("Sent.dm recipient must be an E.164 phone number");
  }

  if (!body) {
    throw new Error("Sent.dm message body cannot be empty");
  }

  if (channel !== "rcs" && channel !== "sms") {
    throw new Error(`Unsupported Sent.dm channel: ${channel}`);
  }

  return { to, body, channel };
}

function extractProviderMessageId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const id =
    record.id ??
    record.messageId ??
    record.message_id ??
    record.external_id ??
    record.externalId;

  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function extractStatus(data: unknown) {
  if (!data || typeof data !== "object") return "queued";
  const record = data as Record<string, unknown>;
  const status = record.status ?? record.delivery_status;
  return typeof status === "string" && status.trim() ? status.trim() : "queued";
}

export async function sendSentMessage(
  input: SendSentMessageInput
): Promise<SendSentMessageResult> {
  const { to, body, channel } = assertValidMessageInput(input);
  const apiKey = getSentApiKey();

  // Sent.dm is the transport only. Supabase owns the durable message record.
  const payload = {
    to: [to],
    channel: [channel],
    body,
    message: body,
    text: body,
  };

  const response = await fetch(SENT_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Sent.dm send failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  return {
    provider: "sent",
    providerMessageId: extractProviderMessageId(data),
    status: extractStatus(data),
    raw: data,
  };
}
