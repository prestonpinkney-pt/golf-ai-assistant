type SendMessageResult = {
  success: boolean;
  provider: string;
  external_id: string | null;
  status: string;
  raw?: unknown;
};

const DEFAULT_TEMPLATE_ID = "5d02d801-587e-4342-bbf6-bf81e475044a";

function deriveDisplayName(input: { name?: string | null; to: string }) {
  const trimmed = input.name?.trim();
  if (trimmed) return trimmed;
  return "there";
}

export async function sendMessage(input: {
  channel: string;
  to: string;
  message: string;
  name?: string | null;
  businessName?: string | null;
  templateId?: string;
  idempotencyKey?: string;
}): Promise<SendMessageResult> {
  const { channel, to, message, name, templateId } = input;
  const apiKey = process.env.SENT_DM_API_KEY;

  if (!apiKey) {
    throw new Error("Missing SENT_DM_API_KEY");
  }

  if (channel !== "sms") {
    throw new Error(`Unsupported channel: ${channel}`);
  }

  const trimmedMessage = (message ?? "").trim();
  if (!trimmedMessage) {
    throw new Error("`message` is required");
  }

  const displayName = deriveDisplayName({ name, to });
  const resolvedTemplateId =
    templateId?.trim() ||
    process.env.SENT_DM_TEMPLATE_ID?.trim() ||
    DEFAULT_TEMPLATE_ID;

  // Single payload object shared by both the dispatched request and the
  // local audit log so that what we log is exactly what we send.
  const payload = {
    to: [to],
    channel: ["sms"],
    template: {
      id: resolvedTemplateId,
      parameters: {
        name: displayName,
        body: trimmedMessage,
        message: trimmedMessage,
      },
    },
  };

  console.log("[sendMessage] dispatching Sent.dm payload:", JSON.stringify(payload));

  const response = await fetch("https://api.sent.dm/v3/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  console.log("[sendMessage] Sent.dm response:", data);

  if (!response.ok) {
    throw new Error(
      `Sent.dm send failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  return {
    success: true,
    provider: "sentdm",
    external_id:
      typeof data?.id === "string"
        ? data.id
        : typeof data?.messageId === "string"
        ? data.messageId
        : null,
    status:
      typeof data?.status === "string"
        ? data.status
        : "queued",
    raw: data,
  };
}
