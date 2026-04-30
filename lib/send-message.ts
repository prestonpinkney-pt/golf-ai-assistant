type SendMessageResult = {
  success: boolean;
  provider: string;
  external_id: string | null;
  status: string;
  raw?: unknown;
};

export async function sendMessage({
  channel,
  to,
  message,
}: {
  channel: string;
  to: string;
  message: string;
}): Promise<SendMessageResult> {
  const apiKey = process.env.SENT_DM_API_KEY;

  console.log("API KEY LOADED:", !!apiKey);

  if (!apiKey) {
    throw new Error("Missing SENT_DM_API_KEY");
  }

  if (channel !== "sms") {
    throw new Error(`Unsupported channel: ${channel}`);
  }

  // ✅ YOUR REAL TEMPLATE ID
  const payload = {
    to: [to],
    channel: ["sms"],
    template: {
      id: "5d02d801-587e-4342-bbf6-bf81e475044a",
      parameters: {
        name: "Test",
      },
    },
  };

  console.log("SENDING PAYLOAD:", JSON.stringify(payload, null, 2));

  const response = await fetch("https://api.sent.dm/v3/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  // ✅ THIS FIXES YOUR "data is not defined"
  const data = await response.json();

  console.log("SENT.DM RESPONSE:", data);

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