import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { normalizePhone } from "./phone";
import { firstString, readPath } from "./webhook-payload";

export { normalizePhone } from "./phone";
export { firstString, readPath } from "./webhook-payload";

export const SENTDM_STATUS_MAP: Record<string, string> = {
  delivered: "delivered",
  sent: "sent",
  failed: "failed",
  bounced: "bounced",
  opened: "opened",
  clicked: "clicked",
  unsubscribed: "unsubscribed",
  complained: "complained",
  rejected: "rejected",
};

export function normalizeSentDmStatus(raw: string | undefined): string {
  if (!raw) return "unknown";
  const lower = raw.toLowerCase().trim();
  return SENTDM_STATUS_MAP[lower] ?? lower;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Header presence only (safe for logs — no secrets). */
export function sentDmWebhookSignatureHeaderPresence(
  req: NextRequest
): Record<string, boolean> {
  const keys = [
    "x-sentdm-signature",
    "x-sent-dm-signature",
    "x-sentdm-secret",
    "x-sent-dm-secret",
    "x-sentdm-timestamp",
    "x-sent-dm-timestamp",
    "sentdm-timestamp",
  ] as const;
  const out: Record<string, boolean> = {};
  for (const k of keys) {
    out[k] = !!req.headers.get(k);
  }
  return out;
}

function parseWebhookTimestampSeconds(req: NextRequest): number | null {
  const raw =
    req.headers.get("x-sentdm-timestamp") ??
    req.headers.get("x-sent-dm-timestamp") ??
    req.headers.get("sentdm-timestamp");
  if (!raw?.trim()) return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return null;
  if (n > 1e12) return Math.floor(n / 1000);
  return Math.floor(n);
}

function webhookTimestampFresh(tsSeconds: number, skewSeconds = 300): boolean {
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - tsSeconds) <= skewSeconds;
}

export type SentDmWebhookVerification =
  | {
      ok: true;
      mode:
        | "hmac_sha256_body"
        | "shared_secret_header"
        | "development_unsigned_allowed"
        | "development_no_secret";
    }
  | { ok: false; reason: string };

/**
 * Validates Sent.dm webhook authenticity.
 * - Production requires `SENTDM_WEBHOOK_SECRET` and valid signature headers (unless explicitly skipped — never default).
 * - Development (`NODE_ENV=development`): allows unsigned requests when secret is set but no signature headers are sent (local testing).
 * - Optional timestamp headers: when present with a verified signature path, checked for freshness (±5 min).
 */
export function verifySentDmAuthenticity(
  req: NextRequest,
  rawBody: string
): SentDmWebhookVerification {
  const secret = process.env.SENTDM_WEBHOOK_SECRET?.trim();
  const isDev = process.env.NODE_ENV === "development";

  if (!secret) {
    if (isDev) {
      return { ok: true, mode: "development_no_secret" };
    }
    return {
      ok: false,
      reason:
        "SENTDM_WEBHOOK_SECRET must be configured in production for Sent.dm webhooks",
    };
  }

  const signatureHeader =
    req.headers.get("x-sentdm-signature") ??
    req.headers.get("x-sent-dm-signature");

  const sharedHeaderRaw =
    req.headers.get("x-sentdm-secret") ?? req.headers.get("x-sent-dm-secret");

  const headersPresent = !!(signatureHeader || sharedHeaderRaw?.trim());

  if (!headersPresent) {
    if (isDev) {
      console.warn(
        "[sentdm-webhook] DEV unsigned webhook accepted (NODE_ENV=development)"
      );
      return { ok: true, mode: "development_unsigned_allowed" };
    }
    return { ok: false, reason: "Missing Sent.dm signature headers" };
  }

  const tsSeconds = parseWebhookTimestampSeconds(req);

  if (signatureHeader) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const provided = signatureHeader.replace(/^sha256=/i, "").trim();
    if (!timingSafeEqualStrings(expected, provided)) {
      return { ok: false, reason: "Invalid Sent.dm signature" };
    }
    if (tsSeconds !== null && !webhookTimestampFresh(tsSeconds)) {
      return { ok: false, reason: "Sent.dm webhook timestamp stale or invalid" };
    }
    return { ok: true, mode: "hmac_sha256_body" };
  }

  const sharedHeader = sharedHeaderRaw?.trim() ?? "";
  if (!timingSafeEqualStrings(sharedHeader, secret)) {
    return { ok: false, reason: "Invalid Sent.dm shared secret header" };
  }

  if (tsSeconds !== null && !webhookTimestampFresh(tsSeconds)) {
    return { ok: false, reason: "Sent.dm webhook timestamp stale or invalid" };
  }

  return { ok: true, mode: "shared_secret_header" };
}

/** Sent.dm v3 envelopes use `sub_type` (e.g. message.received) and nest content under `payload`. */
function normalizedEventLabel(body: Record<string, unknown>): string | null {
  const raw = firstString(body, [
    "sub_type",
    "subtype",
    "payload.sub_type",
    "payload.subtype",
    "event",
    "type",
    "event_type",
    "payload.event",
    "payload.type",
  ]);
  return raw?.toLowerCase().replace(/[_\s]/g, ".") ?? null;
}

/**
 * Lightweight “might be customer SMS” routing heuristic for webhooks (queue + fast ACK).
 *
 * Sent.dm often emits `message.received` for both legs; authoritative classification
 * happens only after GET `/v3/messages/{id}` enrichment (`direction` INBOUND + `status` RECEIVED).
 */
export function looksLikeInboundMessage(body: Record<string, unknown>) {
  const direction = firstString(body, [
    "direction",
    "message.direction",
    "data.direction",
    "payload.direction",
  ])?.toLowerCase();
  if (direction === "inbound" || direction === "incoming") return true;

  const eventType = normalizedEventLabel(body);

  if (
    [
      "message.inbound",
      "message.received",
      "sms.inbound",
      "sms.received",
      "reply.received",
      "reply.inbound",
    ].includes(eventType ?? "")
  ) {
    return true;
  }

  const payloadUnknown = readPath(body, "payload");
  const payloadRecord =
    payloadUnknown &&
    typeof payloadUnknown === "object" &&
    payloadUnknown !== null
      ? (payloadUnknown as Record<string, unknown>)
      : null;
  const hasFrom = normalizePhone(firstString(payloadRecord ?? body, ["from"]));
  const textRaw = firstString(payloadRecord ?? body, [
    "text",
    "body",
    "content",
    "message.text",
    "message.body",
  ]);
  const hasText = (textRaw?.trim().length ?? 0) > 0;
  const field = String(firstString(body, ["field", "payload.field"]) ?? "").toLowerCase();
  const sub = String(
    firstString(body, ["sub_type", "subtype", "payload.sub_type"]) ?? ""
  ).toLowerCase();
  if (
    hasFrom &&
    hasText &&
    field === "message" &&
    (sub.includes("received") || sub === "" || eventType?.includes("received"))
  ) {
    return true;
  }

  // SMS inbound envelope sometimes omits generic `event`/`type` naming; normalize from payload too.
  if (
    hasFrom &&
    hasText &&
    payloadRecord &&
    ["sms", "rcs", ""].includes(String(payloadRecord.channel ?? "").toLowerCase())
  ) {
    const stNorm = normalizedEventLabel(body);
    const subLc = String(
      firstString(body, ["sub_type", "subtype", "payload.sub_type"]) ?? ""
    ).toLowerCase();
    if (
      (stNorm?.includes("received") ?? false) ||
      subLc.includes("received") ||
      (subLc === "" && stNorm == null && !field && !looksLikeOutboundStatus(body))
    ) {
      return true;
    }
  }

  // Real Sent.dm `message.received`: text often absent until GET /v3/messages/{id}; we have inbound_number + message_id.
  if (field === "message" && payloadRecord) {
    const inboundNum = normalizePhone(
      firstString(payloadRecord, ["inbound_number"])
    );
    const mid = firstString(payloadRecord, ["message_id"]);
    const recv =
      (eventType?.includes("message.received") ?? false) ||
      sub.includes("message.received") ||
      sub.includes("received");
    if (recv && inboundNum?.length && (mid?.length ?? 0) > 0) {
      return true;
    }
  }

  return false;
}

function looksLikeOutboundStatus(body: Record<string, unknown>): boolean {
  const s = normalizedEventLabel(body);
  return (
    (s?.includes("delivered") ?? false) ||
    (s?.includes("delivery") ?? false) ||
    (s?.includes("failed") ?? false) ||
    (s?.includes("bounced") ?? false)
  );
}

function inboundForwardOrigin(req: NextRequest): string {
  const configured =
    process.env.CLOSEOS_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  try {
    return new URL(req.url).origin;
  } catch {
    /* fallthrough */
  }
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) {
    return vercel.startsWith("http")
      ? vercel.replace(/\/$/, "")
      : `https://${vercel.replace(/\/$/, "")}`;
  }
  return "http://localhost:3000";
}

export type SentDmInboundForwardResult = {
  ok: boolean;
  status: number;
  result: unknown;
};

/** Normalized inbound fields for Sent.dm payloads (handles nested `payload`). */
export function extractSentDmInboundPayload(
  body: Record<string, unknown>
): {
  phone: string | null;
  messageText: string | null;
  name: string | null;
  toNumber: string | null;
  businessId: string | null;
  businessSlug: string | null;
  channel: "sms" | "rcs";
} {
  const phone = normalizePhone(
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
      "contact.msisdn",
      "data.from",
      "data.phone",
      "data.from.phone",
      "data.from.number",
      "payload.from",
      "payload.phone",
      "payload.from.phone",
      "payload.from.number",
      "payload.inbound_number",
      "inbound_number",
    ])
  );
  const messageText = firstString(body, [
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
  const name = firstString(body, [
    "name",
    "sender_name",
    "contact.name",
    "message.name",
    "data.name",
    "payload.name",
  ]);
  const toNumber = normalizePhone(
    firstString(body, [
      "to",
      "to_number",
      "toNumber",
      "recipient",
      "recipient.phone",
      "recipient.number",
      "message.to",
      "message.to.phone",
      "message.to.number",
      "data.to",
      "data.to.phone",
      "data.to.number",
      "payload.to",
      "payload.to.phone",
      "payload.to.number",
      "payload.outbound_number",
      "outbound_number",
    ])
  );
  const businessId = firstString(body, [
    "business_id",
    "businessId",
    "metadata.business_id",
    "data.business_id",
    "payload.business_id",
  ]);
  const businessSlugRaw = firstString(body, [
    "business_slug",
    "businessSlug",
    "metadata.business_slug",
    "data.business_slug",
    "payload.business_slug",
  ]);

  const text = messageText?.trim() ? messageText.trim() : null;

  const slug = businessSlugRaw?.trim() ? businessSlugRaw.trim() : null;

  const channelRaw =
    firstString(body, [
      "channel",
      "message.channel",
      "data.channel",
      "payload.channel",
    ])?.toLowerCase() ?? "";

  const channel = channelRaw === "rcs" ? "rcs" : ("sms" as const);

  return {
    phone: phone ?? null,
    messageText: text,
    name: name?.trim() ? name.trim() : null,
    toNumber: toNumber ?? null,
    businessId: businessId?.trim() ? businessId.trim() : null,
    businessSlug: slug,
    channel,
  };
}

/** External / Sent.dm message id (supports nested `payload.message_id`). */
export function extractSentDmMessageExternalId(
  body: Record<string, unknown>
): string | null {
  const id = firstString(body, [
    "external_id",
    "externalId",
    "message_id",
    "payload.message_id",
    "payload.messageId",
    "data.message_id",
    "data.messageId",
    "data.id",
    "message.message_id",
    "message.messageId",
    "message.id",
  ]);
  return id?.trim()?.length ? id.trim() : null;
}

/**
 * @deprecated Use webhook queue via `/api/sentdm/webhook` instead of forwarding to `/api/inbound`.
 * Kept for manual debugging only.
 */
export async function forwardSentDmInboundToCloseOs(
  req: NextRequest,
  body: Record<string, unknown>,
  externalId: string
): Promise<SentDmInboundForwardResult> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 500,
      result: { error: "Missing INTERNAL_API_SECRET" },
    };
  }

  const {
    phone,
    messageText: message,
    name,
    toNumber,
    businessId,
    businessSlug,
  } = extractSentDmInboundPayload(body);

  if (!phone || !message) {
    return {
      ok: false,
      status: 400,
      result: {
        error: "Inbound Sent.dm webhook missing phone or message text",
        phone_found: Boolean(phone),
        message_found: Boolean(message),
      },
    };
  }

  const inboundUrl = new URL("/api/inbound", `${inboundForwardOrigin(req)}/`);
  const response = await fetch(inboundUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      phone,
      name,
      to: toNumber,
      source: "sms",
      message,
      provider: "sentdm",
      business_id: businessId,
      business_slug: businessSlug,
      external_id: externalId || null,
      raw_payload: body,
    }),
  });

  const result = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    result,
  };
}

export function isDeliveryFailureStatus(status: string): boolean {
  const s = status.toLowerCase();
  return (
    s === "failed" ||
    s === "bounced" ||
    s === "rejected" ||
    s === "complained"
  );
}
