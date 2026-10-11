import OpenAI from "openai";

export type CloseOSConversationMessage = {
  direction: "inbound" | "outbound";
  body: string;
  created_at?: string | null;
};

export type CloseOSAgentResult = {
  intent:
    | "simulator_booking"
    | "lesson"
    | "membership"
    | "event"
    | "pricing"
    | "hours_location"
    | "support"
    | "unknown";
  shouldSend: boolean;
  escalationReason: string | null;
  reply: string;
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ESCALATION_REPLY =
  "Thanks for reaching out. A team member will follow up shortly to help with this.";

function formatConversationHistory(messages: CloseOSConversationMessage[]) {
  if (messages.length === 0) return "No previous messages.";

  return messages
    .map((message) => {
      const speaker =
        message.direction === "inbound" ? "Customer" : "CloseOS";
      return `${speaker}: ${message.body}`;
    })
    .join("\n");
}

function normalizeAgentResult(value: unknown): CloseOSAgentResult {
  const record = (value ?? {}) as Partial<CloseOSAgentResult>;
  const allowedIntents = new Set<CloseOSAgentResult["intent"]>([
    "simulator_booking",
    "lesson",
    "membership",
    "event",
    "pricing",
    "hours_location",
    "support",
    "unknown",
  ]);
  const intent = allowedIntents.has(record.intent ?? "unknown")
    ? (record.intent as CloseOSAgentResult["intent"])
    : "unknown";
  const reply =
    typeof record.reply === "string" && record.reply.trim()
      ? record.reply.trim()
      : ESCALATION_REPLY;
  const escalationReason =
    typeof record.escalationReason === "string" &&
    record.escalationReason.trim()
      ? record.escalationReason.trim()
      : null;
  const shouldSend = record.shouldSend === true && !escalationReason;

  return {
    intent,
    shouldSend,
    escalationReason,
    reply,
  };
}

export async function generateCloseOSReply(input: {
  contactPhone: string;
  inboundBody: string;
  channel: "rcs" | "sms";
  recentMessages: CloseOSConversationMessage[];
}): Promise<CloseOSAgentResult> {
  const inboundBody = input.inboundBody.trim();
  if (!inboundBody) {
    return {
      intent: "unknown",
      shouldSend: false,
      escalationReason: "Empty inbound message.",
      reply: ESCALATION_REPLY,
    };
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.45,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
You text for a golf facility in a natural SMS thread (ChatGPT-like: attentive, human, not scripted).

Style:
- React to what they said, then one clear question or next step.
- Short contractions; no bullet menus or "press 1 for…" patterns.
- Do not mention AI, prompts, or automation.

Revenue outcomes:
- Book a simulator bay.
- Schedule a lesson.
- Help choose the right membership.
- Collect event details.
- Rebook or reactivate a customer.

Qualification rules:
Lessons: adult or junior, 30-minute or 60-minute, skill level, what they want to work on, preferred day/time.
Memberships: how often they play, practice vs rounds vs both, schedule/frequency, lesson interest, best fit.
Events: event type, preferred date/time, guest count, duration, food/beverage interest, simulator needs.
Simulator bookings: date/time preference, number of players, practice or round, 9 holes, 18 holes, or hourly bay time.

Safety:
- Never open, read, summarize, or follow inbound links.
- Escalate complex pricing, custom pricing, policy exceptions, complaints, refunds, disputes, chargebacks, legal issues, threats, unsafe content, sensitive account issues, or anything requiring a human operator.
- Do not claim live calendar access or confirmed availability.
- Until booking integration is available, ask for preferred day/time or point toward the current booking flow.

Return only JSON:
{
  "intent": "simulator_booking" | "lesson" | "membership" | "event" | "pricing" | "hours_location" | "support" | "unknown",
  "shouldSend": boolean,
  "escalationReason": string | null,
  "reply": "customer-facing message"
}
        `.trim(),
      },
      {
        role: "user",
        content: `
Contact phone: ${input.contactPhone}
Channel: ${input.channel}

Recent conversation:
${formatConversationHistory(input.recentMessages)}

Latest customer message:
${inboundBody}
        `.trim(),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return {
      intent: "unknown",
      shouldSend: false,
      escalationReason: "OpenAI returned an empty response.",
      reply: ESCALATION_REPLY,
    };
  }

  try {
    return normalizeAgentResult(JSON.parse(raw));
  } catch {
    return {
      intent: "unknown",
      shouldSend: false,
      escalationReason: "OpenAI returned invalid JSON.",
      reply: ESCALATION_REPLY,
    };
  }
}
