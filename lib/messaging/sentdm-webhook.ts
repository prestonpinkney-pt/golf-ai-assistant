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
    "x-webhook-signature",
    "x-webhook-id",
    "x-webhook-timestamp",
    // legacy / alternate spellings kept for diagnostics
    "x-sentdm-signature",
    "x-sentdm-timestamp",
    "x-sent-dm-signature",
    "x-sent-dm-timestamp",
    "x-sentdm-secret",
    "x-sent-dm-secret",
  ] as const;
  const out: Record<string, boolean> = {};
  for (const k of keys) {
    out[k] = !!req.headers.get(k);
  }
  return out;
}

function parseWebhookTimestampSeconds(req: NextRequest): number | null {
  const raw =
    req.headers.get("x-webhook-timestamp") ??
    req.headers.get("x-sentdm-timestamp") ??
    req.headers.get("x-sent-dm-timestamp") ??
    req.headers.get("sentdm-timestamp");
  if (!raw?.trim()) return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return null;
  if (n > 1e12) return Math.floor(n / 1000);
  return Math.floor(n);
}

/**
 * Sent.dm HMAC-SHA256 signature verification.
 * Signed content: "{webhookId}.{timestamp}.{rawBody}"
 * Key: base64-decode of secret after stripping "whsec_" prefix.
 * Signature format: "v1,{base64}" — header may contain multiple space-separated values.
 */
function verifySentDmHmacSignature(
  secret: string,
  webhookId: string,
  timestamp: string,
  rawBody: string,
  signatureHeader: string
): boolean {
  const secretStripped = secret.replace(/^whsec_/, "");
  let keyBytes: Buffer;
  try {
    keyBytes = Buffer.from(secretStripped, "base64");
  } catch {
    return false;
  }
  const signedContent = `${webhookId}.${timestamp}.${rawBody}`;
  const expectedB64 = createHmac("sha256", keyBytes)
    .update(signedContent)
    .digest("base64");

  // Header may contain multiple space-separated signatures during key rotation
  const signatures = signatureHeader.split(" ").filter(Boolean);
  for (const sig of signatures) {
    const provided = sig.replace(/^v1,/i, "").trim();
    if (!provided) continue;
    const bufExpected = Buffer.from(expectedB64);
    const bufProvided = Buffer.from(provided);
    if (
      bufExpected.length === bufProvided.length &&
      timingSafeEqual(bufExpected, bufProvided)
    ) {
      return true;
    }
  }

  if (process.env.SENTDM_DEBUG_WEBHOOK_SIGNATURE === "true") {
    console.debug("[sentdm-webhook] signature mismatch debug", {
      webhookId,
      timestamp,
      rawBodyLength: rawBody.length,
      expectedB64,
      signatureHeader,
    });
  }

  return false;
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

export const SENTDM_DEV_UNSIGNED_LOG =
  "[sentdm-webhook] DEV unsigned webhook accepted for local testing only.";

/** True when `SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS=true` (always require HMAC in dev). */
export function isSentDmSignedDevWebhooksRequired(): boolean {
  return (
    process.env.SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS?.trim().toLowerCase() ===
    "true"
  );
}

/** True when `SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS=true` (local smoke only). */
export function isSentDmUnsignedDevWebhooksExplicitlyAllowed(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS?.trim().toLowerCase() ===
      "true"
  );
}

/**
 * Unsigned dev webhooks are opt-in only (`SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS=true`).
 * When `SENTDM_WEBHOOK_SECRET` is set, HMAC is required unless that flag is set.
 */
export function isSentDmUnsignedDevWebhooksAllowed(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    isSentDmUnsignedDevWebhooksExplicitlyAllowed() &&
    !isSentDmSignedDevWebhooksRequired()
  );
}

/**
 * True when `SENTDM_ALLOW_UNSIGNED_WEBHOOKS=true` (any environment).
 * Use when Sent.dm is not configured to sign webhook requests.
 * Webhooks are accepted without signature verification — set this only when
 * Sent.dm signing is unavailable and remove once signing is configured.
 */
export function isSentDmUnsignedWebhooksAllowed(): boolean {
  return (
    process.env.SENTDM_ALLOW_UNSIGNED_WEBHOOKS?.trim().toLowerCase() === "true"
  );
}

/**
 * Validates Sent.dm webhook authenticity.
 * - Production requires `SENTDM_WEBHOOK_SECRET` and valid signature headers.
 * - Development requires HMAC when `SENTDM_WEBHOOK_SECRET` is set; set
 *   `SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS=true` only for unsigned local smoke tests.
 * - Optional timestamp headers: when present with a verified signature path, checked for freshness (±5 min).
 */
export function verifySentDmAuthenticity(
  req: NextRequest,
  rawBody: string
): SentDmWebhookVerification {
  const secret = process.env.SENTDM_WEBHOOK_SECRET?.trim();
  const isDev = process.env.NODE_ENV === "development";
  const allowUnsignedDev = isSentDmUnsignedDevWebhooksAllowed();
  const allowUnsigned = isSentDmUnsignedWebhooksAllowed();

  if (!secret) {
    if (allowUnsigned || (isDev && (allowUnsignedDev || !isSentDmSignedDevWebhooksRequired()))) {
      return { ok: true, mode: "development_no_secret" };
    }
    return {
      ok: false,
      reason:
        "SENTDM_WEBHOOK_SECRET must be configured for Sent.dm webhook signature verification",
    };
  }

  // Sent.dm v3 standard headers
  const signatureHeader = req.headers.get("x-webhook-signature");
  const webhookId = req.headers.get("x-webhook-id");
  const webhookTimestamp = req.headers.get("x-webhook-timestamp");

  // Legacy / fallback headers (kept for compatibility)
  const legacySignatureHeader =
    req.headers.get("x-sentdm-signature") ??
    req.headers.get("x-sent-dm-signature");
  const sharedHeaderRaw =
    req.headers.get("x-sentdm-secret") ?? req.headers.get("x-sent-dm-secret");

  const headersPresent = !!(
    signatureHeader ||
    legacySignatureHeader ||
    sharedHeaderRaw?.trim()
  );

  if (!headersPresent) {
    if (allowUnsigned) {
      console.warn("[sentdm-webhook] Unsigned webhook accepted (SENTDM_ALLOW_UNSIGNED_WEBHOOKS=true). Configure Sent.dm webhook signing to remove this bypass.");
      return { ok: true, mode: "development_unsigned_allowed" };
    }
    if (allowUnsignedDev) {
      console.warn(SENTDM_DEV_UNSIGNED_LOG);
      return { ok: true, mode: "development_unsigned_allowed" };
    }
    return { ok: false, reason: "Missing Sent.dm signature headers" };
  }

  const tsSeconds = parseWebhookTimestampSeconds(req);

  // Primary path: Sent.dm v3 HMAC-SHA256 (x-webhook-signature + x-webhook-id + x-webhook-timestamp)
  if (signatureHeader && webhookId && webhookTimestamp) {
    if (
      !verifySentDmHmacSignature(
        secret,
        webhookId,
        webhookTimestamp,
        rawBody,
        signatureHeader
      )
    ) {
      return { ok: false, reason: "Invalid Sent.dm signature" };
    }
    if (tsSeconds !== null && !webhookTimestampFresh(tsSeconds)) {
      return { ok: false, reason: "Sent.dm webhook timestamp stale or invalid" };
    }
    return { ok: true, mode: "hmac_sha256_body" };
  }

  // Fallback: legacy HMAC header (hex digest, raw body)
  if (legacySignatureHeader) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const provided = legacySignatureHeader.replace(/^sha256=/i, "").trim();
    if (!timingSafeEqualStrings(expected, provided)) {
      return { ok: false, reason: "Invalid Sent.dm signature" };
    }
    if (tsSeconds !== null && !webhookTimestampFresh(tsSeconds)) {
      return { ok: false, reason: "Sent.dm webhook timestamp stale or invalid" };
    }
    return { ok: true, mode: "hmac_sha256_body" };
  }

  // Fallback: shared secret header
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

/**
 * Sent.dm message id for GET /v3/messages/{id} enrichment.
 * Prefers nested `payload.message_id` over top-level `external_id` (correlation ids).
 */
export function extractSentDmMessageIdForLookup(
  body: Record<string, unknown>
): string | null {
  const id = firstString(body, [
    "payload.message_id",
    "payload.messageId",
    "message_id",
    "messageId",
    "data.message_id",
    "data.messageId",
    "data.id",
    "message.message_id",
    "message.messageId",
    "message.id",
    "external_id",
    "externalId",
  ]);
  return id?.trim()?.length ? id.trim() : null;
}

/** External / Sent.dm message id (supports nested `payload.message_id`). */
export function extractSentDmMessageExternalId(
  body: Record<string, unknown>
): string | null {
  return extractSentDmMessageIdForLookup(body);
}

/** Sent.dm / CloseOS contact id from webhook envelope (when present). */
export function extractSentDmContactId(
  body: Record<string, unknown>
): string | null {
  const id = firstString(body, [
    "contactId",
    "contact_id",
    "payload.contactId",
    "payload.contact_id",
    "data.contactId",
    "data.contact_id",
    "contact.id",
    "payload.contact.id",
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

/** True when envelope includes customer message text (any supported path). */
export function hasSentDmInboundText(body: Record<string, unknown>): boolean {
  const { messageText } = extractSentDmInboundPayload(body);
  return (messageText?.trim().length ?? 0) > 0;
}

/**
 * Delivery / lifecycle callbacks (not customer inbound SMS).
 * Used to decide when missing message id should warn about reconciliation.
 */
export function looksLikeDeliveryStatusCallback(
  body: Record<string, unknown>
): boolean {
  if (looksLikeInboundMessage(body)) return false;

  const eventType = normalizedEventLabel(body);
  if (looksLikeOutboundStatus(body)) return true;

  const status = normalizeSentDmStatus(
    (body.status ?? body.delivery_status) as string | undefined
  );
  const deliveryStatuses = new Set([
    "delivered",
    "failed",
    "bounced",
    "rejected",
    "complained",
    "opened",
    "clicked",
    "unsubscribed",
  ]);
  if (deliveryStatuses.has(status)) return true;

  if (
    eventType?.includes("delivered") ||
    eventType?.includes("delivery") ||
    eventType?.includes("failed") ||
    eventType?.includes("bounced") ||
    eventType?.includes("routed") ||
    eventType?.includes("queued")
  ) {
    return true;
  }

  return false;
}

export type SentDmWebhookLogSummary = {
  eventType: string;
  verificationMode: string;
  hasMessageId: boolean;
  hasText: boolean;
  looksInbound: boolean;
  queued: boolean;
  status: string;
  mode?: "local_text_envelope" | "integration_message_lookup";
  reconciled?: boolean;
  externalIdPresent?: boolean;
  ignored?: boolean;
  reason?: string;
  duplicate?: boolean;
};

export function inferInboundWebhookLogMode(input: {
  body: Record<string, unknown>;
  externalId: string;
  looksInbound: boolean;
  queued: boolean;
}): "local_text_envelope" | "integration_message_lookup" | undefined {
  if (
    input.looksInbound &&
    input.queued &&
    input.externalId.trim().length > 0
  ) {
    return "integration_message_lookup";
  }
  if (
    input.looksInbound &&
    input.queued &&
    !input.externalId.trim() &&
    hasSentDmInboundText(input.body)
  ) {
    return "local_text_envelope";
  }
  return undefined;
}

export function buildSentDmWebhookLogSummary(input: {
  eventType: string;
  verificationMode: string;
  body: Record<string, unknown>;
  externalId: string;
  status: string;
  looksInbound: boolean;
  queued?: boolean;
  mode?: "local_text_envelope" | "integration_message_lookup";
  reconciled?: boolean;
  externalIdPresent?: boolean;
  ignored?: boolean;
  reason?: string;
  duplicate?: boolean;
}): SentDmWebhookLogSummary {
  const queued = input.queued ?? false;
  const mode =
    input.mode ??
    inferInboundWebhookLogMode({
      body: input.body,
      externalId: input.externalId,
      looksInbound: input.looksInbound,
      queued,
    });

  const summary: SentDmWebhookLogSummary = {
    eventType: input.eventType,
    verificationMode: input.verificationMode,
    hasMessageId: input.externalId.trim().length > 0,
    hasText: hasSentDmInboundText(input.body),
    looksInbound: input.looksInbound,
    queued,
    status: input.status,
  };

  if (mode) summary.mode = mode;
  if (input.reconciled !== undefined) summary.reconciled = input.reconciled;
  if (input.externalIdPresent !== undefined) {
    summary.externalIdPresent = input.externalIdPresent;
  }
  if (input.ignored) summary.ignored = input.ignored;
  if (input.reason) summary.reason = input.reason;
  if (input.duplicate) summary.duplicate = input.duplicate;

  return summary;
}

/** Warn only when a delivery/status callback cannot reconcile without message id. */
export function shouldWarnMissingExternalId(input: {
  externalId: string;
  looksInbound: boolean;
  body: Record<string, unknown>;
}): boolean {
  if (input.externalId.trim().length > 0) return false;
  if (input.looksInbound) return false;
  return looksLikeDeliveryStatusCallback(input.body);
}

export function logSentDmWebhookSummary(
  route: string,
  summary: SentDmWebhookLogSummary
): void {
  console.log(`[${route}]`, JSON.stringify(summary));
}
