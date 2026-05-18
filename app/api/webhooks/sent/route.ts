import { NextResponse } from "next/server";
import {
  generateCloseOSReply,
  type CloseOSConversationMessage,
} from "@/lib/ai/closeos-agent";
import { sendSentMessage, type SentChannel } from "@/lib/messaging/sent";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createHmac, timingSafeEqual } from "crypto";

type SentWebhookBody = Record<string, unknown>;

type MessageRow = {
  direction: "inbound" | "outbound";
  body: string | null;
  created_at: string | null;
};

const SUPPORTED_INBOUND_EVENTS = new Set([
  "message.inbound",
  "message.received",
  "sms.inbound",
  "sms.received",
  "rcs.inbound",
  "rcs.received",
  "reply.inbound",
  "reply.received",
]);

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

function verifySentWebhookAuthenticity(
  req: Request,
  rawBody: string
): { ok: true } | { ok: false; reason: string } {
  const secret = process.env.SENTDM_WEBHOOK_SECRET;
  if (!secret) {
    return {
      ok: false,
      reason: "SENTDM_WEBHOOK_SECRET is not configured on the server",
    };
  }

  const signatureHeader =
    req.headers.get("x-sentdm-signature") ??
    req.headers.get("x-sent-dm-signature") ??
    req.headers.get("x-sent-signature");

  if (signatureHeader) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const provided = signatureHeader.replace(/^sha256=/i, "").trim();
    if (timingSafeEqualStrings(expected, provided)) {
      return { ok: true };
    }
    return { ok: false, reason: "Invalid Sent.dm signature" };
  }

  const sharedHeader =
    req.headers.get("x-sentdm-secret") ??
    req.headers.get("x-sent-dm-secret") ??
    req.headers.get("x-sent-secret");
  if (sharedHeader && timingSafeEqualStrings(sharedHeader, secret)) {
    return { ok: true };
  }

  return { ok: false, reason: "Missing Sent.dm signature" };
}

function readPath(source: SentWebhookBody, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

function firstString(source: SentWebhookBody, paths: string[]) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizeEventType(body: SentWebhookBody) {
  return (
    firstString(body, ["event", "type", "event_type"]) ?? "unknown"
  )
    .toLowerCase()
    .replace(/[_\s]/g, ".");
}

function normalizePhone(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return null;
}

function normalizeChannel(value: string | null): SentChannel {
  const normalized = value?.toLowerCase();
  return normalized === "sms" ? "sms" : "rcs";
}

function extractInboundMessage(body: SentWebhookBody) {
  const eventType = normalizeEventType(body);
  const direction = firstString(body, [
    "direction",
    "message.direction",
    "data.direction",
    "payload.direction",
  ])?.toLowerCase();

  const isInbound =
    SUPPORTED_INBOUND_EVENTS.has(eventType) ||
    direction === "inbound" ||
    direction === "incoming";

  if (!isInbound) {
    return { ok: false as const, reason: "unsupported_event", eventType };
  }

  const contactPhone = normalizePhone(
    firstString(body, [
      "from",
      "from_number",
      "fromNumber",
      "sender",
      "phone",
      "msisdn",
      "message.from",
      "message.phone",
      "from.phone",
      "from.number",
      "sender.phone",
      "sender.number",
      "contact.phone",
      "data.from",
      "data.phone",
      "data.from.phone",
      "data.from.number",
      "payload.from",
      "payload.phone",
      "payload.from.phone",
      "payload.from.number",
    ])
  );
  const bodyText = firstString(body, [
    "text",
    "body",
    "content",
    "message",
    "message.text",
    "message.body",
    "message.content",
    "data.text",
    "data.body",
    "data.message",
    "data.message.text",
    "data.message.body",
    "data.content",
    "payload.text",
    "payload.body",
    "payload.message",
    "payload.message.text",
    "payload.message.body",
    "payload.content",
  ]);
  const channel = normalizeChannel(
    firstString(body, [
      "channel",
      "message.channel",
      "data.channel",
      "payload.channel",
    ])
  );
  const providerMessageId = firstString(body, [
    "id",
    "message_id",
    "messageId",
    "external_id",
    "externalId",
    "message.id",
    "data.id",
    "payload.id",
  ]);

  if (!contactPhone) {
    return { ok: false as const, reason: "missing_valid_phone", eventType };
  }

  if (!bodyText?.trim()) {
    return { ok: false as const, reason: "empty_message", eventType };
  }

  return {
    ok: true as const,
    eventType,
    contactPhone,
    bodyText: bodyText.trim(),
    channel,
    providerMessageId,
  };
}

function shouldEscalateBeforeAi(body: string) {
  const lower = body.toLowerCase();
  const hasLink = /https?:\/\/|www\./i.test(body);
  const asksToOpenLink =
    hasLink && /\b(open|read|click|review|summarize|check)\b/i.test(body);
  const riskyTerms = [
    "refund",
    "chargeback",
    "dispute",
    "lawsuit",
    "legal",
    "complaint",
    "custom price",
    "custom pricing",
    "discount",
    "policy exception",
  ];

  if (asksToOpenLink) {
    return "Customer asked CloseOS to open or inspect an inbound link.";
  }

  const matched = riskyTerms.find((term) => lower.includes(term));
  return matched ? `Sensitive or operator-required topic: ${matched}` : null;
}

async function insertMessage(input: {
  contactPhone: string;
  direction: "inbound" | "outbound";
  channel: SentChannel;
  body: string;
  status: string;
  providerMessageId?: string | null;
}) {
  const supabase = createSupabaseServiceClient();

  const { data, error } = await supabase
    .from("messages")
    .insert({
      contact_phone: input.contactPhone,
      direction: input.direction,
      channel: input.channel,
      provider: "sent",
      body: input.body,
      status: input.status,
      provider_message_id: input.providerMessageId ?? null,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to save ${input.direction} message: ${error.message}`);
  }

  return data;
}

async function loadRecentMessages(contactPhone: string) {
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("messages")
    .select("direction, body, created_at")
    .eq("contact_phone", contactPhone)
    .order("created_at", { ascending: false })
    .limit(12);

  if (error) {
    throw new Error(`Failed to load conversation history: ${error.message}`);
  }

  return ((data ?? []) as MessageRow[])
    .reverse()
    .filter((message) => typeof message.body === "string")
    .map((message) => ({
      direction: message.direction,
      body: message.body ?? "",
      created_at: message.created_at,
    }));
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const verification = verifySentWebhookAuthenticity(req, rawBody);
  if (!verification.ok) {
    console.warn(`[CloseOS sent webhook] Rejected request: ${verification.reason}`);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: SentWebhookBody;

  try {
    payload = rawBody ? (JSON.parse(rawBody) as SentWebhookBody) : {};
  } catch {
    return NextResponse.json(
      { ok: false, ignored: true, reason: "invalid_json" },
      { status: 400 }
    );
  }

  const inbound = extractInboundMessage(payload);
  if (!inbound.ok) {
    return NextResponse.json({
      ok: true,
      ignored: true,
      reason: inbound.reason,
      event_type: inbound.eventType,
    });
  }

  try {
    await insertMessage({
      contactPhone: inbound.contactPhone,
      direction: "inbound",
      channel: inbound.channel,
      body: inbound.bodyText,
      status: "received",
      providerMessageId: inbound.providerMessageId,
    });

    const preAiEscalation = shouldEscalateBeforeAi(inbound.bodyText);
    if (preAiEscalation) {
      console.log("[CloseOS sent webhook] Escalated before AI:", preAiEscalation);
      return NextResponse.json({
        ok: true,
        sent: false,
        escalated: true,
        escalation_reason: preAiEscalation,
      });
    }

    const recentMessages = await loadRecentMessages(inbound.contactPhone);
    const agentResult = await generateCloseOSReply({
      contactPhone: inbound.contactPhone,
      inboundBody: inbound.bodyText,
      channel: inbound.channel,
      recentMessages,
    });

    if (!agentResult.shouldSend) {
      console.log(
        "[CloseOS sent webhook] Agent escalated:",
        agentResult.escalationReason
      );
      return NextResponse.json({
        ok: true,
        sent: false,
        escalated: true,
        intent: agentResult.intent,
        escalation_reason: agentResult.escalationReason,
      });
    }

    const sent = await sendSentMessage({
      to: inbound.contactPhone,
      body: agentResult.reply,
      channel: inbound.channel,
    });

    await insertMessage({
      contactPhone: inbound.contactPhone,
      direction: "outbound",
      channel: inbound.channel,
      body: agentResult.reply,
      status: sent.status,
      providerMessageId: sent.providerMessageId,
    });

    return NextResponse.json({
      ok: true,
      sent: true,
      intent: agentResult.intent,
      status: sent.status,
      provider_message_id: sent.providerMessageId,
    });
  } catch (error) {
    console.error("[CloseOS sent webhook] Failed:", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "CloseOS sent webhook failed",
      },
      { status: 500 }
    );
  }
}
